const util = require('util');
const request = require('request');
const get = util.promisify(request.get);
const post = util.promisify(request.post);

class TidepoolSync {
  constructor(env, ctx) {
    console.log('*** TIDEPOOL SERVER');
    // console.log(env);
    // console.log(ctx);
    this.ctx = ctx;
    this.sbx = null;
    this.env = env;
    this.settings = env.extendedSettings.tidepool;
    this.listEntries = util.promisify(this.ctx.entries.list);

    this.state = this.STATES.CONNECTING;

    this.tidepool = {
      token: null,
      userID: null,
      uploadID: null,
    };

    this.ctx.bus.on('data-received', () => {
      console.log(' *** TIDEPOOL SERVER data-received');
      // console.log(this.ctx);
    });
    this.ctx.bus.on('data-loaded', () => {
      console.log(' *** TIDEPOOL SERVER data-loaded');
      // console.log(this.ctx);
      (async () => {
        try {
          const records = await this.listEntries({ find: { date: { $gte: new Date("2020-05-09T00:00:00Z").getTime() } }, count: 100 });
          console.log(' *** TIDEPOOL SERVER data-loaded RECORDS');
          console.log(this.tidepool);
          // console.log(Object.keys(this.ctx.ddata));
          console.log(records);
          console.log(`Number of records: ${records.length}`);
          // this.uploadData(records);
        } catch (error) {
          console.log(error);
        }
      })();
    });

    (async () => {
      // Non-blocking login.
      console.log(' *** TIDEPOOL SERVER connectToTidepool');
      await this.connectToTidepool();
      console.log(this.tidepool);
    })();
  }

  get tidepoolClientName() {
    return 'com.github.nightscout.cgm-remote-monitor.tidepool-plugin';
  }
  get tidepoolClientVersion() {
    return '0.1.0';
  }

  get STATES() {
    return {
      CONNECTING: 'Connecting',
      CONNECTED: 'Connected',
      FAILED: 'Failed',
    }
  }

  async uploadData(data) {
    // console.log(JSON.stringify(data, null, 2));
    console.log('*** TIDEPOOL UPLOAD_DATA');
    console.log(this.tidepool);
    // console.log(data);
    // console.log(this.ctx);
    // const records = await this.listEntries({ count: 100 });
    // console.log(records);
    // console.log(JSON.stringify(data.sgvs, null, 2));
    // console.log(JSON.stringify(data.tempbasalTreatments, null, 2));
    // console.log(JSON.stringify(data.mbgs, null, 2));

    // curl 'https://int-api.tidepool.org/dataservices/v1/datasets/<upload-session-id>/data' –H 'x-tidepool-session-token: <your-session-token>' –H 'Content-Type: application/json' --data-binary '[<array of diabetes device data objects>]'
  }

  requestOptions() {
    return {
      headers: {
        'X-Tidepool-Session-Token': this.tidepool.token,
        'User-Agent': this.tidepoolClientName,
        'X-Tidepool-Client-Name': this.tidepoolClientName,
        'X-Tidepool-Client-Version': this.tidepoolClientVersion,
      },
      json: true,
    }
  }

  authFailed() {
    this.tidepool.token = null;
    this.tidepool.userID = null;
    this.tidepool.uploadID = null;
    this.state = this.STATES.FAILED;
  }

  async connectToTidepool() {
    if (this.state === this.STATES.CONNECTING) {
      console.info('Logging into Tidepool');
      let response = await post(`${this.settings.apiHost}/auth/login`,
        {
          auth: { user: this.settings.userName, pass: this.settings.password },
          json: true,
        }
      );
      if (response.statusCode === 200) {
        console.info('Tidepool login succeeded');
        this.tidepool.token = response.headers['x-tidepool-session-token'];
        this.tidepool.userID = response.body.userid;
        this.state = this.STATES.CONNECTED;
      } else {
        console.warn('Tidepool login failed');
        this.authFailed();
      }

      // Do we have an existing upload session for this plugin?
      response = await get(`${this.settings.apiHost}/v1/users/${this.tidepool.userID}/data_sets?client.name=${this.tidepoolClientName}`,
        this.requestOptions()
      );
      if (response.statusCode === 200) {
        if (response.body && response.body.length > 0) {
          this.tidepool.uploadID = response.body[0].uploadId;
        } else {
          // No existing upload session. Start a new one.
          const options = this.requestOptions();
          options.body = {
            client: {
              name: this.tidepoolClientName,
              version: this.tidepoolClientVersion,
            },
            dataSetType: 'continuous',
            deduplicator: {
              name: 'org.tidepool.deduplicator.dataset.delete.origin',
            },
          };
          response = await post(`${this.settings.apiHost}/v1/users/${this.tidepool.userID}/data_sets`, options);
          if (response.statusCode === 200) {
            this.tidepool.uploadID = response.body.data.uploadId;
          } else {
            this.authFailed();
          }
        }
      } else {
        this.authFailed();
      }
    }
  }

  static init(env, ctx) {
    return new TidepoolSync(env, ctx);
  }
}

module.exports = TidepoolSync.init;
