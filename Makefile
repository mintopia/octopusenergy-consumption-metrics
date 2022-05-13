.PHONY: node2nix
node2nix:
	node2nix --development \
			 --composition node2nix.nix \
			 --lock package-lock.json
