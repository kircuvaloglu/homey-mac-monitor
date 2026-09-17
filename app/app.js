'use strict';

const Homey = require('homey');

module.exports = class MacMonitorApp extends Homey.App {

  async onInit() {
    this.log('Mac Monitor started');
  }

};
