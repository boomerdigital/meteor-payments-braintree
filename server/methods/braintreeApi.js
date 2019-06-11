/* eslint camelcase: 0 */
import Braintree from "braintree";
import accounting from "accounting-js";
import Future from "fibers/future";
import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { Packages } from "/lib/collections";
import Logger from "@reactioncommerce/logger";
import Reaction from "/imports/plugins/core/core/server/Reaction";

let moment;
async function lazyLoadMoment() {
  if (moment) return;
  moment = await import("moment");
}

export const BraintreeApi = {};
BraintreeApi.apiCall = {};

function getSettings(settings, ref, valueName) {
  if (settings !== null) {
    return settings[valueName];
  } else if (ref !== null) {
    return ref[valueName];
  }
  return undefined;
}

function getAccountOptions(isPayment) {
  const queryConditions = {
    name: "reaction-braintree",
    shopId: Reaction.getShopId()
  };
  if (isPayment) {
    queryConditions.enabled = true;
  }

  const { settings } = Packages.findOne(queryConditions);
  let environment;
  if (typeof settings !== "undefined" && settings !== null ? settings.mode : undefined === true) {
    environment = "production";
  } else {
    environment = "sandbox";
  }

  const ref = Meteor.settings.braintree;
  const options = {
    environment,
    merchantId: getSettings(settings, ref, "merchant_id"),
    publicKey: getSettings(settings, ref, "public_key"),
    privateKey: getSettings(settings, ref, "private_key")
  };
  if (!options.merchantId) {
    throw new Meteor.Error("invalid-credentials", "Invalid Braintree Credentials");
  }
  return options;
}

function getGateway(isNewPayment) {
  const accountOptions = getAccountOptions(isNewPayment);
  if (accountOptions.environment === "production") {
    accountOptions.environment = Braintree.Environment.Production;
  } else {
    accountOptions.environment = Braintree.Environment.Sandbox;
  }
  const gateway = Braintree.connect(accountOptions);
  return gateway;
}

function getRefundDetails(refundId) {
  check(refundId, String);
  const gateway = getGateway();
  const braintreeFind = Meteor.wrapAsync(gateway.transaction.find, gateway.transaction);
  const findResults = braintreeFind(refundId);
  return findResults;
}


BraintreeApi.apiCall.paymentSubmit = function (paymentSubmitDetails) {
  const isNewPayment = true;
  const gateway = getGateway(isNewPayment);
  const fut = new Future();

  gateway.transaction.sale(
    {
      amount: paymentSubmitDetails.amount,
      paymentMethodNonce: paymentSubmitDetails.paymentData.nonceToken,
      options: {
        // This option requests the funds from the transaction
        // once it has been authorized successfully
        submitForSettlement: true
      }
    },
    function(error, result) {
      if (error) {
        Reaction.Events.warn(error);
        fut.return({
          saved: false,
          error
        });
      }
      else if(!result.success){
        fut.return({
          saved: false,
          response: result
        });
      } else {
        fut.return({
          saved: true,
          response: result
        });
      }
    }
  );
  return fut.wait();
};


BraintreeApi.apiCall.captureCharge = function (paymentCaptureDetails) {
  const { transactionId } = paymentCaptureDetails;
  const amount = accounting.toFixed(paymentCaptureDetails.amount, 2);
  const gateway = getGateway();
  const fut = new Future();

  if (amount === accounting.toFixed(0, 2)) {
    gateway.transaction.void(transactionId, (error, result) => {
      if (error) {
        fut.return({
          saved: false,
          error
        });
      } else {
        fut.return({
          saved: true,
          response: result
        });
      }
    }, (e) => {
      Logger.warn(e);
    });
    return fut.wait();
  }
  gateway.transaction.submitForSettlement(transactionId, amount, Meteor.bindEnvironment((error, result) => {
    if (error) {
      fut.return({
        saved: false,
        error
      });
    } else {
      fut.return({
        saved: true,
        response: result
      });
    }
  }, (e) => {
    Logger.warn(e);
  }));

  return fut.wait();
};


BraintreeApi.apiCall.createRefund = function (refundDetails) {
  const { amount, transactionId } = refundDetails;
  const gateway = getGateway();
  const fut = new Future();
  gateway.transaction.refund(transactionId, amount, Meteor.bindEnvironment((error, result) => {
    if (error) {
      fut.return({
        saved: false,
        error
      });
    } else if (!result.success) {
      if (result.errors.errorCollections.transaction.validationErrors.base[0].code === "91506") {
        fut.return({
          saved: false,
          error: "Braintree does not allow refunds until transactions are settled. This can take up to 24 hours. Please try again later."
        });
      } else {
        fut.return({
          saved: false,
          error: result.message
        });
      }
    } else {
      fut.return({
        saved: true,
        response: result
      });
    }
  }, (e) => {
    Logger.fatal(e);
  }));
  return fut.wait();
};


BraintreeApi.apiCall.listRefunds = function (refundListDetails) {
  const { transactionId } = refundListDetails;
  const gateway = getGateway();
  const braintreeFind = Meteor.wrapAsync(gateway.transaction.find, gateway.transaction);
  const findResults = braintreeFind(transactionId);
  const result = [];
  if (findResults.refundIds.length > 0) {
    Promise.await(lazyLoadMoment());
    for (const refund of findResults.refundIds) {
      const refundDetails = getRefundDetails(refund);
      result.push({
        type: "refund",
        amount: parseFloat(refundDetails.amount),
        created: moment(refundDetails.createdAt).unix() * 1000,
        currency: refundDetails.currencyIsoCode,
        raw: refundDetails
      });
    }
  }

  return result;
};
