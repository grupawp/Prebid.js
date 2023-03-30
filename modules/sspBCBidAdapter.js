import { deepAccess, deepSetValue, getWindowTop, isArray, logWarn } from '../src/utils.js';
import { ajax } from '../src/ajax.js';
import { config } from '../src/config.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { BANNER, NATIVE, VIDEO } from '../src/mediaTypes.js';
import { includes as strIncludes } from '../src/polyfill.js';

const BIDDER_CODE = 'sspBC';
const BIDDER_URL = 'https://ssp.wp.pl/bidder/';
const SYNC_URL = 'https://ssp.wp.pl/bidder/usersync';
const NOTIFY_URL = 'https://ssp.wp.pl/bidder/notify';
const GVLID = 676;
const TMAX = 450;
const BIDDER_VERSION = '6.0';
const DEFAULT_CURRENCY = 'PLN';
const W = window;
const { navigator } = W;
const oneCodeDetection = {};
const adUnitsCalled = {};
const adSizesCalled = {};
const pageView = {};
var consentApiVersion;

/**
 * Native asset mapping - we use constant id per type
 * id > 10 indicates additional images
 */
var nativeAssetMap = {
  title: 0,
  cta: 1,
  icon: 2,
  image: 3,
  body: 4,
  sponsoredBy: 5
};

/**
 * Get language of top level html object
 * @returns {string} languageCode - ISO language code
 */
const getContentLanguage = () => {
  try {
    const topWindow = getWindowTop();
    return topWindow.document.body.parentNode.lang;
  } catch (err) {
    logWarn('Could not read language form top-level html', err);
  }
};

/**
 * Re-format ortb 2.5 native object
 * @param {object} native payload
 * @returns {object} updated payload
 */
const formatNativePayload = payload => {
  const { request } = payload;
  try {
    const requestObject = JSON.parse(request);
    const { native, assets } = requestObject;
    if (assets && !native) {
      payload.request = JSON.stringify({
        native: { assets }
      });
    }
  } catch (err) {
    logWarn('Error reading native payload', err);
  }

  return payload;
};

/**
 * Re-format ortb 2.5 consent data
 * @param {object} request payload
 * @returns {object} updated payload
 */
const formatGDPR = payload => {
  const { regs = {}, user = {} } = payload;
  const { ext: regsExt = {} } = regs;
  const { ext: userExt = {} } = user;

  if (regsExt.gdpr != undefined) {
    payload.regs.gdpr = regsExt.gdpr;
    payload.regs.ext.gdpr = undefined;
  }

  if (userExt.consent != undefined) {
    payload.user.consent = userExt.consent;
    payload.user.ext.consent = undefined;
    payload.user.ext.ConsentedProvidersSettings = undefined;
  }
};

/**
 * opern rtb converter
 */
const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 300
  },

  overrides: {
    // overrides are executed before processor
    // all processors are called for all impressions (banner, video, native for all imps)
    /*
    imp: {
      banner(orig, imp, bidRequest, context) {
        logWarn('Override for banner', imp, bidRequest);
        orig(imp, bidRequest, context);
      },
      video(orig, imp, bidRequest, context) {
        logWarn('Override for video', imp, bidRequest);
        orig(imp, bidRequest, context);
      },
      native(orig, imp, bidRequest, context) {
        logWarn('Override for native', imp, bidRequest);
        orig(imp, bidRequest, context);
      },
    }
   response: {

   }
   */
  },

  imp(buildImp, bidRequest, context) {
    const { bidId, adUnitCode, sizes, params = {} } = bidRequest;
    const { id, siteId } = params;
    const imp = buildImp(bidRequest, context);

    // Set id (pseudorandom, or equal to params.id) and tagid (equal to adunitcode)
    imp.id = id && siteId ? id.padStart(3, '0') : 'bidid-' + bidId;
    imp.tagid = adUnitCode;

    // Check floorprices
    const { floor, currency } = getHighestFloor(bidRequest);
    imp.bidfloor = floor;
    imp.bidfloorcur = currency;

    // Pass largest size x times used as ext.pbsize
    const impSize = sizes.length ? sizes.reduce((prev, next) => prev[0] * prev[1] <= next[0] * next[1] ? next : prev).join('x') : '1x1';

    if (!adUnitsCalled[adUnitCode]) {
      // this is a new adunit - assign & save pbsize
      adSizesCalled[impSize] = adSizesCalled[impSize] ? adSizesCalled[impSize] += 1 : 1;
      adUnitsCalled[adUnitCode] = `${impSize}_${adSizesCalled[impSize]}`;
    }

    deepSetValue(imp, 'ext.data.pbsize', adUnitsCalled[adUnitCode]);

    // Native payload has to bo formatted to be 2.6 compliant
    const { native } = imp;
    imp.native = native && formatNativePayload(native);

    // Video payload needs context property
    const { video = {} } = imp;
    const { placement } = video;
    if (placement === 1) {
      imp.video.context = 'instream';
    } else if (placement === 2) {
      imp.video.context = 'outstream';
    }

    logWarn('converter -> build imp', bidRequest, imp, context);

    return imp;
  },

  request(buildRequest, imps, bidderRequest, context) {
    const { bidRequests = [] } = context;
    const { bids = [] } = bidderRequest;
    const request = buildRequest(imps, bidderRequest, context);

    // get site id and test mode
    const siteId = setOnAny(bidRequests, 'params.siteId') || request.site.id;
    const isTest = setOnAny(bidRequests, 'params.test') || undefined;

    request.site.id = siteId;
    request.site.content = { language: getContentLanguage() };
    request.test = isTest;
    request.tmax = TMAX;

    // add client hints and user IDs
    applyClientHints(request);
    applyUserIds(bids[0], request);

    // reformat consent data to be 2.6 compliant
    formatGDPR(request);

    return request;
  },

  response(buildResponse, bidResponses, ortbResponse, context) {
    logWarn('Before bid response', arguments);
    const bidResponse = buildResponse(bidResponses, ortbResponse, context);
    return bidResponse;
  }
});

/**
 * return native asset type, based on asset id
 * @param {int} id - native asset id
 * @returns {string} asset type
 */
const getNativeAssetType = id => {
  // id>10 will always be an image...
  if (id > 10) {
    return 'image';
  }

  // ...others should be decoded from nativeAssetMap
  for (let assetName in nativeAssetMap) {
    const assetId = nativeAssetMap[assetName];
    if (assetId === id) {
      return assetName;
    }
  }
}

/**
 * Get Bid parameters - returns bid params from Object, or 1el array
 * @param {*} bidData - bid (bidWon), or array of bids (timeout)
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
        requestId: undefined,
        siteId: [],
        slotId: [],
        tagid: [],
      }
      bids.forEach(bid => {
        const { adUnitCode, auctionId, cpm, creativeId, meta, params: bidParams, requestId, timeout } = bid;
        const params = unpackParams(bidParams);

        // basic notification data
        const bidBasicData = {
          requestId: auctionId || result.requestId,
          timeout: timeout || result.timeout,
          pvid: pageView.id,
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
          const bidNonEmptyData = {
            cpm,
            cpmpl: meta && meta.pricepl,
            creativeId,
            adomain: meta && meta.advertiserDomains && meta.advertiserDomains[0],
            networkName: meta && meta.networkName,
          }
          result = { ...result, ...bidNonEmptyData }
        }
      })
      return result;
    }
  }
}

const applyClientHints = ortbRequest => {
  const { location } = document;
  const { connection = {}, deviceMemory, userAgentData = {} } = navigator;
  const viewport = W.visualViewport || false;
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
    Should be generated during first call to applyClientHints(),
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

const applyUserIds = (validBidRequest, ortbRequest) => {
  const eids = validBidRequest.userIdAsEids
  if (eids && eids.length) {
    const ids = { eids };
    ortbRequest.user = { ...ortbRequest.user, ...ids };
  }
};

/**
 * Get highest floorprice for a given adslot
 * (sspBC adapter accepts one floor per imp)
 * returns floor = 0 if getFloor() is not defined
 *
 * @param {object} slot bid request adslot
 * @returns {float} floorprice
 */
const getHighestFloor = (slot) => {
  const currency = getCurrency();
  let result = { floor: 0, currency };

  if (typeof slot.getFloor === 'function') {
    let bannerFloor = 0;

    if (slot.sizes.length) {
      bannerFloor = slot.sizes.reduce(function (prev, next) {
        const { floor: currentFloor = 0 } = slot.getFloor({
          mediaType: 'banner',
          size: next,
          currency
        });
        return prev > currentFloor ? prev : currentFloor;
      }, 0);
    }

    const { floor: nativeFloor = 0 } = slot.getFloor({
      mediaType: 'native', currency
    });

    const { floor: videoFloor = 0 } = slot.getFloor({
      mediaType: 'video', currency
    });

    result.floor = Math.max(bannerFloor, nativeFloor, videoFloor);
  }

  return result;
};

/**
 * Get currency (either default or adserver)
 * @returns {string} currency name
 */
const getCurrency = () => config.getConfig('currency.adServerCurrency') || DEFAULT_CURRENCY;

/**
 * Get value for first occurence of key within the collection
 */
const setOnAny = (collection, key) => collection.reduce((prev, next) => prev || deepAccess(next, key), false);

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

const isVideoAd = bid => {
  const xmlTester = new RegExp(/^<\?xml/);
  return bid.adm && bid.adm.match(xmlTester);
}

const isNativeAd = bid => {
  const xmlTester = new RegExp(/^{['"]native['"]/);

  return bid.admNative || (bid.adm && bid.adm.match(xmlTester));
}

const parseNative = (nativeData, adUnitCode) => {
  const { link = {}, imptrackers: impressionTrackers, jstracker } = nativeData;
  const { url: clickUrl, clicktrackers: clickTrackers = [] } = link;
  const macroReplacer = tracker => tracker.replace(new RegExp('%native_dom_id%', 'g'), adUnitCode);
  let javascriptTrackers = isArray(jstracker) ? jstracker : jstracker && [jstracker];

  // replace known macros in js trackers
  javascriptTrackers = javascriptTrackers && javascriptTrackers.map(macroReplacer);

  const result = {
    clickUrl,
    clickTrackers,
    impressionTrackers,
    javascriptTrackers,
  };

  nativeData.assets.forEach(asset => {
    const { id, img = {}, title = {}, data = {} } = asset;
    const { w: imgWidth, h: imgHeight, url: imgUrl, type: imgType } = img;
    const { type: dataType, value: dataValue } = data;
    const { text: titleText } = title;
    const detectedType = getNativeAssetType(id);
    if (titleText) {
      result.title = titleText;
    }
    if (imgUrl) {
      // image or icon
      const thisImage = {
        url: imgUrl,
        width: imgWidth,
        height: imgHeight,
      };
      if (imgType === 3 || detectedType === 'image') {
        result.image = thisImage;
      } else if (imgType === 1 || detectedType === 'icon') {
        result.icon = thisImage;
      }
    }
    if (dataValue) {
      // call-to-action, sponsored-by or body
      if (dataType === 1 || detectedType === 'sponsoredBy') {
        result.sponsoredBy = dataValue;
      } else if (dataType === 2 || detectedType === 'body') {
        result.body = dataValue;
      } else if (dataType === 12 || detectedType === 'cta') {
        result.cta = dataValue;
      }
    }
  });

  return result;
}

const spec = {
  code: BIDDER_CODE,
  gvlid: GVLID,
  aliases: [],
  supportedMediaTypes: [BANNER, NATIVE, VIDEO],
  isBidRequestValid(bid) {
    // as per OneCode integration, bids without params are valid
    return true;
  },
  buildRequests(validBidRequests, bidderRequest) {
    if ((!validBidRequests) || (validBidRequests.length < 1)) {
      return false;
    }

    const pbver = '$prebid.version$';
    const payload = converter.toORTB({ validBidRequests, bidderRequest });

    return {
      method: 'POST',
      url: `${BIDDER_URL}?bdver=${BIDDER_VERSION}&pbver=${pbver}&inver=0`,
      data: JSON.stringify(payload),
      bidderRequest,
    };
  },

  interpretResponse(serverResponse, request) {
    const bidsFromConverter = converter.fromORTB({ response: serverResponse.body, request: request.data }).bids;
    logWarn('Converting ortb response', bidsFromConverter);

    const { bidderRequest } = request;
    const response = serverResponse.body;
    const bids = [];
    let site = request.data ? JSON.parse(request.data).site : {}; // get page and referer data from request
    site.sn = response.sn || 'mc_adapter'; // WPM site name (wp_sn)
    pageView.sn = site.sn; // store site_name (for syncing and notifications)
    let seat;

    if (response.seatbid !== undefined) {
      /*
        Match response to request, by comparing bid id's
        'bidid-' prefix indicates oneCode (parameterless) request and response
      */
      response.seatbid.forEach(seatbid => {
        seat = seatbid.seat;
        seatbid.bid.forEach(serverBid => {
          // get data from bid response
          const { adomain, crid = `mcad_${bidderRequest.auctionId}_${site.slot}`, impid, exp = 300, ext = {}, price, w, h } = serverBid;

          let bidRequest = bidderRequest.bids.filter(b => {
            const { bidId, params: requestParams = {} } = b;
            const params = unpackParams(requestParams);
            const { id, siteId } = params;
            const currentBidId = id && siteId ? id : 'bidid-' + bidId;
            return currentBidId === impid;
          })[0];

          // get bidid from linked bidRequest
          const { bidId } = bidRequest || {};

          // get ext data from bid
          const { siteid = site.id, slotid = site.slot, pubid, adlabel, cache: creativeCache, vurls = [] } = ext;

          // update site data
          site = {
            ...site,
            ...{
              id: siteid,
              slot: slotid,
              publisherId: pubid,
              adLabel: adlabel
            }
          };

          if (bidRequest && site.id && !strIncludes(site.id, 'bidid')) {
            // found a matching request; add this bid
            const { adUnitCode } = bidRequest;

            // store site data for future notification
            oneCodeDetection[bidId] = [site.id, site.slot];

            const bid = {
              requestId: bidId,
              creativeId: crid,
              cpm: price,
              currency: response.cur,
              ttl: exp,
              width: w,
              height: h,
              bidderCode: BIDDER_CODE,
              meta: {
                advertiserDomains: adomain,
                networkName: seat,
                pricepl: ext && ext.pricepl,
              },
              netRevenue: true,
              vurls,
            };

            // mediaType and ad data for instream / native / banner
            if (isVideoAd(serverBid)) {
              // video
              bid.adType = 'instream';
              bid.mediaType = 'video';
              bid.vastXml = serverBid.adm;
              bid.vastContent = serverBid.adm;
              bid.vastUrl = creativeCache;
            } else if (isNativeAd(serverBid)) {
              // native
              bid.mediaType = 'native';
              // check native object
              try {
                const nativeData = serverBid.admNative || JSON.parse(serverBid.adm).native;
                bid.native = parseNative(nativeData, adUnitCode);
                bid.width = 1;
                bid.height = 1;
              } catch (err) {
                logWarn('Could not parse native data', serverBid.adm);
                bid.cpm = 0;
              }
            } else {
              // banner ad (default)
              bid.mediaType = 'banner';
              bid.ad = serverBid.adm;
            }

            if (bid.cpm > 0) {
              // push this bid
              bids.push(bid);
            }
          } else {
            logWarn('Discarding response - no matching request / site id', serverBid.impid);
          }
        });
      });
    }

    return bids;
  },
  getUserSyncs(syncOptions, serverResponses, gdprConsent) {
    let mySyncs = [];
    // TODO: the check on CMP api version does not seem to make sense here. It means "always run the usersync unless an old (v1) CMP was detected". No attention is paid to the consent choices.
    if (syncOptions.iframeEnabled && consentApiVersion != 1) {
      mySyncs.push({
        type: 'iframe',
        url: `${SYNC_URL}?tcf=${consentApiVersion}&pvid=${pageView.id}&sn=${pageView.sn}`,
      });
    };
    return mySyncs;
  },

  onTimeout(timeoutData) {
    const payload = getNotificationPayload(timeoutData);
    if (payload) {
      payload.event = 'timeout';
      sendNotification(payload);
      return payload;
    }
  },

  onBidWon(bid) {
    const payload = getNotificationPayload(bid);
    if (payload) {
      payload.event = 'bidWon';
      sendNotification(payload);
      return payload;
    }
  },
};

registerBidder(spec);

export {
  spec,
};
