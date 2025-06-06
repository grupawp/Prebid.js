import { getWinDimensions, getWindowTop, isArray, logWarn } from '../src/utils.js';
import { ajax } from '../src/ajax.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import { convertOrtbRequestToProprietaryNative } from '../src/native.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';

const BIDDER_CODE = 'sspBC';
const BIDDER_URL = 'https://ssp.wp.pl/bidder/';
const SYNC_URL_IFRAME = 'https://ssp.wp.pl/bidder/usersync';
const SYNC_URL_IMAGE = 'https://ssp.wp.pl/v1/sync/pixel';
const NOTIFY_URL = 'https://ssp.wp.pl/bidder/notify';
const GVLID = 676;
const BIDDER_VERSION = '7.00';
const W = window;
const oneCodeDetection = {};
const adUnitsCalled = {};
const adSizesCalled = {};
const bidderRequestsMap = {};
const pageView = {};

const applyClientHints = ortbRequest => {
  const { location } = document;
  const { connection = {}, deviceMemory, userAgentData = {} } = navigator;
  const viewport = getWinDimensions().visualViewport || false;
  const segments = [];
  const hints = {
    'CH-Ect': connection.effectiveType,
    'CH-Rtt': connection.rtt,
    'CH-SaveData': connection.saveData,
    'CH-Downlink': connection.downlink,
    'CH-DeviceMemory': deviceMemory,
    'CH-Dpr': W.devicePixelRatio,
    'CH-ViewportWidth': viewport.width,
    'CH-BrowserBrands': JSON.stringify(userAgentData.brands),
    'CH-isMobile': userAgentData.mobile,
  };

  /**
    Check / generate page view id
    Should be generated dureing first call to applyClientHints(),
    and re-generated if pathname has changed
   */
  if (!pageView.id || location.pathname !== pageView.path) {
    pageView.path = location.pathname;
    pageView.id = Math.floor(1E20 * Math.random()).toString();
  }

  Object.keys(hints).forEach(key => {
    const hint = hints[key];

    if (hint) {
      segments.push({
        name: key,
        value: hint.toString(),
      });
    }
  });
  const data = [
    {
      id: '12',
      name: 'NetInfo',
      segment: segments,
    }, {
      id: '7',
      name: 'pvid',
      segment: [
        {
          value: pageView.id
        }
      ]
    }];

  const ch = { data };
  ortbRequest.user = { ...ortbRequest.user, ...ch };
};

const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 300,
    nativeRequest: {
      eventtrackers: [
        { event: 1, methods: [1, 2] },
      ]
    }
  },
  imp(buildImp, bidRequest, context) {
    const imp = buildImp(bidRequest, context);
    const { adUnitCode, sizes, params = {} } = bidRequest;
    const { id = '' } = params;
    const slotSize = sizes.length ? sizes.reduce((prev, next) => prev[0] * prev[1] <= next[0] * next[1] ? next : prev).join('x') : '1x1';

    if (!adUnitsCalled[adUnitCode]) {
      adSizesCalled[slotSize] = adSizesCalled[slotSize] ? adSizesCalled[slotSize] += 1 : 1;
      adUnitsCalled[adUnitCode] = `${slotSize}_${adSizesCalled[slotSize]}`;
    }

    imp.id = id;
    imp.tagid = adUnitCode;
    imp.ext.data = { pbsize: adUnitsCalled[adUnitCode] } || {}

    return imp;
  },
  request(buildRequest, imps, bidderRequest, context) {
    const req = buildRequest(imps, bidderRequest, context);
    const { site = {}, refererInfo = {} } = req;
    const { bids } = bidderRequest;
    const { params = {} } = bids[0];
    const { siteId } = params;
    const { ref } = refererInfo;

    applyClientHints(req);

    site.id = siteId;
    site.content = { language: getContentLanguage() };
    site.ref = ref || null;

    return req;
  },
  response(buildResponse, bidResponse, ortbResponse, context) {
    const response = buildResponse(bidResponse, ortbResponse, context);

    return response;
  },
  bidResponse(buildBidResponse, bidResponse, context) {
    const { bidRequest, seatbid } = context;
    const { seat } = seatbid;
    const { mediaTypes } = bidRequest
    const { ext } = bidResponse;
    const { pricepl, platform, vurls = [] } = ext;

    context.mediaType = Object.keys(mediaTypes)[0];

    const bid = buildBidResponse(bidResponse, context);

    bid.meta.networkName = seat;
    bid.meta.pricepl = pricepl;
    bid.meta.platform = platform;
    bid.vurls = vurls;

    return bid;
  },
});

/**
 * Get language of top level html object
 * @returns {string} languageCode - ISO language code
 */
const getContentLanguage = () => {
  try {
    const topWindow = getWindowTop();
    return topWindow.document.body.parentNode.lang;
  } catch (err) {
    logWarn('Could not read language from top-level html', err);
  }
};

/**
 * Get host name of the top level html object
 * @returns {string} host name
 */
const getTopHost = () => {
  try {
    const topWindow = getWindowTop();
    return topWindow.location.host;
  } catch (err) {
    logWarn('Could not read host from top-level window', err);
  }
};

/**
 * Get Bid parameters - returns bid params from Object, or 1el array
 * @param {*} bidParams - bid (bidWon), or array of bids (timeout)
 * @returns {object} params object
 */
const unpackParams = (bidParams) => {
  const result = isArray(bidParams) ? bidParams[0] : bidParams;
  return result || {};
}

/**
 * Get bid parameters for notification
 * @param {*} bidData - bid (bidWon), or array of bids (timeout)
 */
const getNotificationPayload = bidData => {
  if (bidData) {
    const bids = isArray(bidData) ? bidData : [bidData];
    if (bids.length > 0) {
      let result = {
        siteId: [],
        slotId: [],
        tagid: [],
      }
      bids.forEach(bid => {
        const { adUnitCode, cpm, creativeId, meta = {}, mediaType, params: bidParams, bidderRequestId, requestId, timeout } = bid;
        const { platform = 'wpartner' } = meta;
        const params = unpackParams(bidParams);

        // basic notification data
        const bidBasicData = {
          requestId: bidderRequestId || bidderRequestsMap[requestId],
          timeout: timeout || result.timeout,
          pvid: pageView.id,
          platform
        }
        result = { ...result, ...bidBasicData }

        result.tagid.push(adUnitCode);

        // check for stored detection
        if (oneCodeDetection[requestId]) {
          params.siteId = oneCodeDetection[requestId][0];
          params.id = oneCodeDetection[requestId][1];
        }
        if (params.siteId) {
          result.siteId.push(params.siteId);
        }
        if (params.id) {
          result.slotId.push(params.id);
        }

        if (cpm) {
          // non-empty bid data
          const { advertiserDomains = [], networkName, pricepl } = meta;
          const bidNonEmptyData = {
            cpm,
            cpmpl: pricepl,
            creativeId,
            adomain: advertiserDomains[0],
            adtype: mediaType,
            networkName,
          }
          result = { ...result, ...bidNonEmptyData }
        }
      })
      return result;
    }
  }
}

/**
 * Send payload to notification endpoint
 */
const sendNotification = payload => {
  ajax(NOTIFY_URL, null, JSON.stringify(payload), {
    contentType: 'application/json',
    withCredentials: false,
    method: 'POST',
    crossOrigin: true
  });
}

const isBidRequestValid = () => {
  // as per OneCode integration, bids without params are valid
  return true;
};

const buildRequests = (validBidRequests, bidderRequest) => {
  // convert Native ORTB definition to old-style prebid native definition
  validBidRequests = convertOrtbRequestToProprietaryNative(validBidRequests);

  if ((!validBidRequests) || (validBidRequests.length < 1)) {
    return false;
  }

  const dataConverted = converter.toORTB({bidderRequest});
  const pbver = '$prebid.version$';

  return {
    method: 'POST',
    url: `${BIDDER_URL}?bdver=${BIDDER_VERSION}&pbver=${pbver}&inver=0`,
    data: dataConverted,
    bidderRequest,
  };
};

const interpretResponse = (serverResponse, request) => {
  const { data } = request;
  const { body } = serverResponse;
  const { ext: responseExt = {} } = body;
  const { paapi: fledgeAuctionConfigs = [] } = responseExt;

  const interpretedResponse = converter.fromORTB({response: body, request: data});

  const bids = interpretedResponse.bids || [];

  return fledgeAuctionConfigs.length ? { bids, fledgeAuctionConfigs } : bids;
};

const getUserSyncs = (syncOptions, _, gdprConsent = {}) => {
  const {iframeEnabled, pixelEnabled} = syncOptions;
  const {gdprApplies, consentString = ''} = gdprConsent;
  let mySyncs = [];
  if (iframeEnabled) {
    mySyncs.push({
      type: 'iframe',
      url: `${SYNC_URL_IFRAME}?tcf=2&pvid=${pageView.id}&sn=${pageView.sn}`,
    });
  } else if (pixelEnabled) {
    mySyncs.push({
      type: 'image',
      url: `${SYNC_URL_IMAGE}?inver=0&platform=wpartner&host=${getTopHost() || ''}&gdpr=${gdprApplies ? 1 : 0}&gdpr_consent=${consentString}`,
    });
  }
  return mySyncs;
};

const onTimeout = (timeoutData) => {
  const payload = getNotificationPayload(timeoutData);
  if (payload) {
    payload.event = 'timeout';
    sendNotification(payload);
    return payload;
  }
};

const onBidderError = (errorData) => {
  const payload = getNotificationPayload(errorData);
  if (payload) {
    payload.event = 'parseError';
    sendNotification(payload);
    return payload;
  }
};

const onBidViewable = (bid) => {
  const payload = getNotificationPayload(bid);
  if (payload) {
    payload.event = 'bidViewable';
    sendNotification(payload);
    return payload;
  }
};

const onBidBillable = (bid) => {
  const payload = getNotificationPayload(bid);
  if (payload) {
    payload.event = 'bidBillable';
    sendNotification(payload);
    return payload;
  }
};

const onBidWon = (bid) => {
  const payload = getNotificationPayload(bid);
  if (payload) {
    payload.event = 'bidWon';
    sendNotification(payload);
    return payload;
  }
};

const spec = {
  code: BIDDER_CODE,
  gvlid: GVLID,
  aliases: [],
  supportedMediaTypes: [BANNER, NATIVE, VIDEO],
  isBidRequestValid,
  buildRequests,
  interpretResponse,
  getUserSyncs,
  onTimeout,
  onBidderError,
  onBidViewable,
  onBidBillable,
  onBidWon
};

registerBidder(spec);

export {
  spec,
};
