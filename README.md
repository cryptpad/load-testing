# CryptPad Load testing

## Installation

Install with `npm i`

## Usage

First configure your instance with the parameters to be set in the `CONFIG`
block in `index.js`.

Then you can run the script `index.js`:

`node index.js --users=100 --offset=100`

### Options

The script accepts the following options:

- `--users=[number]`: the number of users to spawn
- `--offset=[number]`: the offset from which to start the user generation (to launch the
  load tester multiple times without colliding for instance)
- `--delay=[number]`: the average delay between two patches (in ms, should be > 300). The
  delay between two queries is sampled uniformly from [300, 2 × delay - 300)
- `--queries=[number]`: the limit of queries to be sent (default: 0 which means unlimited)
- `--blobs=[number]`: number of blobs to be sent (default: undefined which means none)
- `--history`: if set, only send get history requests, don’t send patch (to verify)
- `--create`: if set, only initialize users (don’t send patch)
- `--loop`: if set, with `--blobs` set, loop indefinitely the blob upload
- `--no-ask`: don’t ask after init and start immediately
- `--no-patch`: deprecated, was used instead of `--create`
