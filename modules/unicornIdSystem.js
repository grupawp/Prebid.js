/**
 * This module adds unicornId to the User ID module
 * The {@link module:modules/userId} module is required
 * @module modules/unicornId
 * @requires module:modules/userId
 */

import { MODULE_TYPE_UID } from '../src/activities/modules.js';
import { logInfo } from '../src/utils.js';
import { getStorageManager } from '../src/storageManager.js';
import { submodule } from '../src/hook.js';

const MODULE_NAME = 'unicornId';
const ID_TOKEN = 'unicornToken';
const storage = getStorageManager({ moduleName: MODULE_NAME, moduleType: MODULE_TYPE_UID });

/**
 * @typedef {import('../modules/userId/index.js').Submodule} Submodule
 * @typedef {import('../modules/userId/index.js').SubmoduleConfig} SubmoduleConfig
 * @typedef {import('../modules/userId/index.js').ConsentData} ConsentData
 * @typedef {import('../modules/userId/index.js').IdResponse} IdResponse
 */

/** @type {Submodule} */
export const unicornIdSubmodule = {
  /**
   * used to link submodule with config
   * @type {string}
   */
  name: MODULE_NAME,
  gvlid: 676,
  /**
   * decode the stored id value for passing to bid requests
   * @function decode
   * @param {(Object|string)} value
   * @returns {(Object|undefined)}
   */
  decode(value) {
    logInfo('unicornId: decode', value);
    return typeof value === 'string' ? { 'unicornId': value } : undefined;
  },
  /**
   * performs action to obtain id and return a value in the callback's response argument
   * @function
   * @param {SubmoduleConfig} [config]
   * @param {ConsentData} [consentData]
   * @param {(Object|undefined)} cacheIdObj
   * @returns {IdResponse|undefined}
   */
  getId(config) {
    const unicornIdToken = storage.getDataFromLocalStorage(ID_TOKEN);
    logInfo('unicornId: getId', config, unicornIdToken);
    return { id: unicornIdToken };
  },
  eids: {
    'unicornId': {
      source: 'unicorn.com',
      atype: 1
    },
  }
};

submodule('userId', unicornIdSubmodule);
