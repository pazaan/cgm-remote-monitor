const _ = require('lodash');
const axios = require('axios');
const bifrost = require('/Users/lennart/Documents/OpenSource/bifrost');
const moment = require('moment');
const util = require('util');
const createAuthRefreshInterceptor = require('axios-auth-refresh').default;

class TidepoolSync {
  constructor(env, ctx) {
    this.ctx = ctx;
    this.sbx = null;
    this.env = env;
    this.settings = env.extendedSettings.tidepool;

    // Our instance of axios for making HTTP requests to Tidepool
    this.axios = axios.create({
      baseURL: this.settings.apiHost,
      headers: {
        'User-Agent': this.tidepoolClientName,
        'X-Tidepool-Client-Name': this.tidepoolClientName,
        'X-Tidepool-Client-Version': this.tidepoolClientVersion,
      },
      validateStatus: function (status) {
        return status >= 200 && status < 401;
      },
    });

    // Set up an Tidepool authentication refresh mechanism, for when we get
    // 401's or 403's.
    createAuthRefreshInterceptor(this.axios,
      this.refreshAuthLogic(this.axios, this.settings.userName, this.settings.password),
      { statusCodes: [401, 403], retryInstance: this.axios });

    // Promisify Nightscout functions.
    this.getEntries = util.promisify(this.ctx.entries.list);
    this.getTreatments = util.promisify(this.ctx.treatments.list);

    this.state = this.STATES.CONNECTING;
    this.tidepool = {
      userID: null,
      uploadID: null,
    };

    this.ctx.bus.on('data-received', () => {
      this.processData();
    });
    this.ctx.bus.on('data-loaded', () => {
      this.processData();
    });

    (async () => {
      // Non-blocking login.
      await this.connectToTidepool();
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

  getProfiles(startDate) {
    return new Promise((resolve, reject) => {
      this.ctx.profile()
        .find({ startDate: { "$gte": startDate } })
        .sort({ startDate: -1 })
        .toArray((err, data) => {
          err ? reject(err) : resolve(data);
        });
    })
  }

  refreshAuthLogic(axiosInstance, username, password) {
    return async (failedRequest) => {
      console.info('tidepoolsync> Obtaining new Tidepool session token');
      const tokenRefreshResponse = await axiosInstance.post(`${failedRequest.config.baseURL}/auth/login`, {},
        {
          auth: { username: username, password: password },
        }
      );
      // eslint-disable-next-line require-atomic-updates
      axiosInstance.defaults.headers.common['X-Tidepool-Session-Token'] = tokenRefreshResponse.headers['x-tidepool-session-token']
    }
  }

  async connectToTidepool() {
    try {
      console.info('tidepoolsync> Logging into Tidepool');
      // Set the logged in user ID. Calling this without already being logged in
      // will trigger the `refreshAuthLogic` above.
      let response = await this.axios.get('auth/user');
      this.tidepool.userID = response.data.userid;
      this.state = this.STATES.CONNECTED;

      // Do we have an existing upload session for this plugin?
      response = await this.axios.get(`v1/users/${this.tidepool.userID}/data_sets?client.name=${this.tidepoolClientName}`);
      if (response.status === 200) {
        if (response.data && response.data.length > 0) {
          this.tidepool.uploadID = response.data[0].uploadId;
        } else {
          // No existing upload session. Start a new one.
          const data = {
            client: {
              name: this.tidepoolClientName,
              version: this.tidepoolClientVersion,
            },
            dataSetType: 'continuous',
            deduplicator: {
              name: 'org.tidepool.deduplicator.dataset.delete.origin',
            },
          };
          response = await this.axios.post(`v1/users/${this.tidepool.userID}/data_sets`, data);
          if (response.status === 200) {
            this.tidepool.uploadID = response.data.data.uploadId;
          } else {
            throw new Error('Could not create new Upload Session');
          }
        }
      } else {
        throw new Error('Could not check state of Upload Session');
      }

      // TODO: Figure out how much data we should initially upload to Tidepool.
      /*
      const response = await this.axios.get(`data/${this.tidepool.userID}?uploadId=${this.tidepool.uploadID}&latest=true&type=cbg`);
      console.log(response.data);
      */
    } catch (err) {
      console.error(`Error connecting to Tidepool: ${err}`);
      this.tidepool.userID = null;
      this.tidepool.uploadID = null;
      this.state = this.STATES.FAILED;
    }
  }

  async processData() {
    if (this.state === this.STATES.CONNECTED) {
      // Make a TidepoolDataManager, to clean up data to be to Tidepool's liking
      const tidepoolData = new TidepoolDataManager();

      // Get all of the profiles during the treatment period.
      // The last treatment is the oldest.
      // The last profile is the oldest.
      // TODO: Check `profileTreatments` to find any profile switches (ie, not defaults).
      // TODO: Upload profiles to Tidepool.

      // const entries = await this.getEntries({ find: { date: { $gte: new Date("2020-05-09T00:00:00Z").getTime() } }, count: 100 });
      const entries = await this.getEntries({ count: 500 });
      console.log(`Number of entries: ${entries.length}`);
      const treatments = await this.getTreatments({ count: 500 });
      console.log(`Number of treatments: ${treatments.length}`);
      // TODO: Need to also find the profile that was _already active_ at the oldest treatment.
      const profiles = await this.getProfiles(_.last(treatments).created_at);
      console.log('=== PROFILES');
      console.log(JSON.stringify(profiles, null, 2));

      // FIXME: Don't `concat` (ie, copy in memory). Can we span?
      for (const treatment of _.concat(profiles, treatments, entries)) {
        const rawData = treatment;
        // Convert ObjectID to string.
        rawData['_id'] = rawData['_id'].toString();
        try {
          const nsDatum = bifrost.Nightscout.Factory.from(rawData);
          let tidepoolDatum = null;
          switch (nsDatum.constructor) {
            case bifrost.Nightscout.SGV:
              tidepoolDatum = new bifrost.Tidepool.CBG();
              break;
            case bifrost.Nightscout.TempBasal:
              tidepoolDatum = new bifrost.Tidepool.TempBasal();
              break;
            case bifrost.Nightscout.CorrectionBolus:
              tidepoolDatum = new bifrost.Tidepool.NormalBolus();
              break;
            case bifrost.Nightscout.MealBolus:
              tidepoolDatum = new bifrost.Tidepool.Food();
              break;
            case bifrost.Nightscout.Profile:
              tidepoolDatum = new bifrost.Tidepool.PumpSettings();
              break;
            default:
              throw new Error('Unknown type returned from Factory');
          }
          nsDatum.convert(tidepoolDatum);
          tidepoolDatum.validate();
          tidepoolData.addDatum(tidepoolDatum);
        } catch (err) {
          console.log(`Couldn't convert data: ${err.message}`);
          console.log(rawData);
        }
      }

      try {
        console.log('WOULD UPLOAD HERE');
        // await this.uploadData(tidepoolData.data);
      } catch (err) {
        console.log(`Error uploading data: ${err.message}`);
      }
    }
  }

  async uploadData(data) {
    if (!Array.isArray(data)) {
      throw new Error('Data uploaded to Tidepool must be of type Array');
    }

    console.log('Uploading data to Tidepool...');
    // TODO: Use _.chunk to split into chunks of 1000.
    try {
      const response = await this.axios.post(`dataservices/v1/datasets/${this.tidepool.uploadID}/data`, data);
      console.log('GOT HERE');
      if (response.status !== 200) {
        throw new Error(`Could not upload data: ${JSON.stringify(response.data)}`);
      }
    } catch (err) {
      throw new Error(`Could not upload data: ${err}`);
    }
    console.log('Finished upload to Tidepool.');
  }

  static init(env, ctx) {
    return new TidepoolSync(env, ctx);
  }
}

// Modifies events to be in a form that Tidepool likes them.
// In particular, Tidepool's data model wants Basal types `time + duration` to be exactly the same as the following `time`.
class TidepoolDataManager {
  constructor() {
    this._data = [];
  }

  // Data is added newest to oldest.
  addDatum(datum) {
    const datumToAdd = datum.toJSON();
    if (datum.constructor === bifrost.Tidepool.TempBasal) {
      // Find the profile that was active at the time of this TempBasal so that we can
      // populate the `suppressed` data.
      // TODO: Handle Profile Switches
      const activeProfile = _.find(this._data, item => {
        // console.log(`=== TIME: ${datumToAdd.time}`);
        // console.log(item);
        // TODO: find correct time
        // return item.type === 'pumpSettings' && item.time <= datumToAdd.time
        return item.type === 'pumpSettings';
      });
      // TODO: Handle invalid activeProfile
      const scheduledBasal = _.find(activeProfile.basalSchedules[activeProfile.activeSchedule], );
      console.log(`=== FOUND MATCHING SCHEDULE: ${JSON.stringify(activeProfile, null, 2)}`);
      console.log(`    --- ${JSON.stringify(datumToAdd, null, 2)}`);
      datumToAdd.data.suppressed = {
        type: 'basal',
        deliveryType: 'scheduled',
        rate: 1.5,
      }

      // Find the previous Basal to determine whether it should join to this one
      const previousBasal = _.findLast(this._data, { type: 'basal' });
      if (previousBasal) {
        const timeGap = -moment(datumToAdd.time).utc().add(datumToAdd.duration, 'ms').diff(previousBasal.time);
        if (timeGap < 60000) {
          // If there's less than a minute gap between two samples, adjust the duration to connect them together
          datumToAdd.duration = moment(previousBasal.time).diff(datumToAdd.time);
        } else if (timeGap > 0) {
          // If there's more than a minute gap between two samples, inject a Scheduled Basal event.
          // TODO: No hax, plox.
          const time = moment(datumToAdd.time).utc().add(datumToAdd.duration, 'ms').toISOString();
          const scheduledBasal = {
            time,
            duration: moment(previousBasal.time).diff(time),
            origin: {
              id: `post-${datumToAdd.origin.id}`, // TODO: what to do if there are no temps, only scheduled basals?
              name: 'github.com/pazaan/bifrost',
              type: 'service',
            },
            type: 'basal',
            deliveryType: 'scheduled',
            rate: 1.5,
          }
          this._data.push(scheduledBasal);
        }
      }
    }
    this._data.push(datumToAdd);
  }

  get data() {
    return this._data;
  }
}

module.exports = TidepoolSync.init;
