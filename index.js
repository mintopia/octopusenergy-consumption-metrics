// Libraries
const process = require('process');
const {
    InfluxDB,
    Point
} = require('@influxdata/influxdb-client');
const { toNanoDate } = require("influx");
const { GraphQLClient, gql } = require('graphql-request');

const axios = require('axios');
const dotenv = require('dotenv');
const sleep = require('./sleep');

dotenv.config();

// Env Vars
const {
    OCTO_API_KEY,
    OCTO_ELECTRIC_SN,
    OCTO_ELECTRIC_MPAN,
    OCTO_GAS_MPRN,
    OCTO_GAS_SN,
    OCTO_ELECTRIC_COST,
    OCTO_GAS_COST,
    INFLUXDB_URL,
    INFLUXDB_TOKEN,
    INFLUXDB_ORG,
    INFLUXDB_BUCKET,
    LOOP_TIME,
    PAGE_SIZE,
    OCTO_ACCOUNT_NUMBER
} = process.env;

const restRequest = url => {
    url = `https://api.octopus.energy/v1${url}`;
    return axios.get(url, {
        auth: {
            username: OCTO_API_KEY
        }
    });
};

const consumption = async ({ type, mp, sn, cost, writeApi }) => {
    const url = `/${type}-meter-points/${mp}/meters/${sn}/consumption?page_size=${PAGE_SIZE}`;
    const response = await restRequest(url);
    for await (var point of response.data.results) {
        const timestamp = toNanoDate(String(new Date(point.interval_end).valueOf()) + '000000');
        await writeApi.writePoint(
            new Point(type)
                .floatField('consumption', Number(point.consumption))
                .timestamp(timestamp));

        if(cost) {
            await writeApi.writePoint(
                new Point(`${type}_cost`)
                    .floatField('price', Number(point.consumption) * Number(OCTO_ELECTRIC_COST) / 100)
                    .timestamp(timestamp));
        };
    }
};

const tariff = async (writeApi) => {
    if(!OCTO_ACCOUNT_NUMBER) {
        return Promise.resolve();
    }

    const endpoint = 'https://api.octopus.energy/v1/graphql/';
    let client = new GraphQLClient(endpoint);
    const token = await client.request(gql`
      mutation obtainKrakenToken($key: String!) {
        obtainKrakenToken(input: {APIKey: $key}) {
          token
        }
      }
    `, {
        key: OCTO_API_KEY
    }).then(response => response.obtainKrakenToken.token);

    client = new GraphQLClient(endpoint, {
        headers: {
            Authorization: token
        }
    });
    return client.request(gql`
      query account($account: String!) {
        account(accountNumber: $account) {
          number
          electricityAgreements {
            tariff {
              ... on StandardTariff {
                displayName
                fullName
                productCode
                tariffCode
                standingCharge
                unitRate
              }
            }
          }
          gasAgreements {
            tariff {
              displayName
              fullName
              productCode
              tariffCode
              standingCharge
              unitRate
          }
        }
      }
    }`, {
        account: OCTO_ACCOUNT_NUMBER
    }).then(async ({ account }) => {
        const timestamp = toNanoDate(String(new Date().valueOf()) + '000000');
        await Promise.all(account.gasAgreements.map(async ({ tariff }) => {
            await writeApi.writePoint(
                new Point('gas_tariff')
                    .timestamp(timestamp)
                    .stringField('displayName', tariff.displayName)
                    .stringField('fullName', tariff.fullName)
                    .stringField('productCode', tariff.productCode)
                    .stringField('tariffCode', tariff.tariffCode)
                    .stringField('account', OCTO_ACCOUNT_NUMBER)
                    .floatField('unitRate', Number(tariff.unitRate))
                    .floatField('standingCharge', Number(tariff.standingCharge)));
        }));
        await Promise.all(account.electricityAgreements.map(async ({ tariff }) => {
            await writeApi.writePoint(
                new Point('electricity_tariff')
                    .timestamp(timestamp)
                    .stringField('displayName', tariff.displayName)
                    .stringField('fullName', tariff.fullName)
                    .stringField('productCode', tariff.productCode)
                    .stringField('tariffCode', tariff.tariffCode)
                    .stringField('account', OCTO_ACCOUNT_NUMBER)
                    .floatField('unitRate', Number(tariff.unitRate))
                    .floatField('standingCharge', Number(tariff.standingCharge)));
        }));
    });
};

const boot = async (callback) => {
    console.log("Starting Octopus Energy Consumption Metrics Container");
    console.log("Current Settings are:");
    console.log(`
        OCTO_API_KEY = ${OCTO_API_KEY ? '*****' : undefined}
        OCTO_ELECTRIC_MPAN = ${OCTO_ELECTRIC_MPAN}
        OCTO_ELECTRIC_SN = ${OCTO_ELECTRIC_SN}
        OCTO_GAS_MPAN = ${OCTO_GAS_MPRN}
        OCTO_GAS_SN = ${OCTO_GAS_SN}
        INFLUXDB_URL = ${INFLUXDB_URL}
        INFLUXDB_TOKEN = ${INFLUXDB_TOKEN ? '*****' : undefined}
        INFLUXDB_ORG = ${INFLUXDB_ORG}
        INFLUXDB_BUCKET = ${INFLUXDB_BUCKET}
        LOOP_TIME = ${LOOP_TIME}
        OCTO_ELECTRIC_COST = ${OCTO_ELECTRIC_COST}
        OCTO_GAS_COST = ${OCTO_GAS_COST}
        PAGE_SIZE = ${PAGE_SIZE}
        OCTO_ACCOUNT_NUMBER = ${OCTO_ACCOUNT_NUMBER}
    `);


    while (true){
        // Set up influx client
        const client = new InfluxDB({
            url: INFLUXDB_URL,
            token: INFLUXDB_TOKEN
        });
        const writeApi = client.getWriteApi(INFLUXDB_ORG, INFLUXDB_BUCKET);
        writeApi.useDefaultTags({
            app: 'octopus-energy-consumption-metrics'
        });

        await Promise.all([
            tariff(writeApi),
            consumption({
                writeApi,
                type: 'electricity',
                mp: OCTO_ELECTRIC_MPAN,
                sn: OCTO_ELECTRIC_SN,
                cost: OCTO_ELECTRIC_COST
            }),
            consumption({
                writeApi,
                type: 'gas',
                mp: OCTO_GAS_MPRN,
                sn: OCTO_GAS_SN,
                cost: OCTO_GAS_COST
            })
        ]);

        console.log("Polling data from octopus API");

        await writeApi
            .close()
            .then(() => {
                console.log('Octopus API response submitted to InfluxDB successfully');
            })
            .catch(e => {
                console.error(e);
                console.log('Error submitting data to InfluxDB');
            });

        // Now sleep for the loop time
        console.log("Sleeping for: " + LOOP_TIME);
        sleep(Number(LOOP_TIME));
    }
}

boot((error) => {
    if (error) {
        console.error(error);
        throw(error.message || error);
    }
  });
