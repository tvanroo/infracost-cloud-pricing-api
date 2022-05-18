
import fs, { WriteStream } from 'fs';
import axios, { AxiosResponse } from 'axios';

import { Product, Price } from '../db/types';
// import { generateProductHash, generatePriceHash } from '../db/helpers';
import { upsertProducts } from '../db/upsert';
import config from '../config';

const baseUrl = 'https://cloud.ibm.com/kubernetes/api';
const filename = `data/ibm-instances.json`;
const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 3;
const vendorName = 'ibm';
const serviceId = 'containers-kubernetes';

/**
 * Product Mapping:
 * DB:             | ibmProductJson:
 * --------------- | -----------------
 * productHash:    | md5(vendorName + flavor + region + operating_system + plan_id + country + currency);
 * sku:            | plan_id
 * vendorName:     | 'ibm'
 * region:         | region
 * service:        | 'containers-kubernetes'
 * productFamily:  | ''
 * attributes:     | IBM Attributes []
 * prices:         | Price[]
 */

/** 
 * Price Mapping:
 * DB Price:           | ibmProductJson & ibmTiersJson:
 * ------------------- | -------------------------
 * priceHash:          | md5()
 * purchaseOption:     | ''
 * unit:               | unit
 * USD?:               | ibmTiersJson.price
 * CNY?:               | NOT USED
 * effectiveDateStart: | effective_from
 * effectiveDateEnd:   | effective_until
 * startUsageAmount:   | min_quantity || ''
 * endUsageAmount:     | max_quantity || ibmTiersJson.instance_hours
 * termLength:         | contract_duration || ''
 * termPurchaseOption  | NOT USED
 * termOfferingClass   | NOT USED
 * description         | NOT USED
 */

type ibmProductJson = {
  provider: string;
  flavor: string;
  region: string;
  isolation: string;
  operating_system: string;
  contract_duration: string;
  ocp_included: boolean;
  catalog_region: string;
  server_type: string;
  min_quantity: number;
  max_quantity: number;
  deprecated: boolean;
  plan_id: string;
  billing_type: string;
  effective_from: string;
  effective_until: string;
  unit: string;
  price: string;
  tiers: ibmTiersJson[];
  country: string;
  currency: string;
};

type ibmTiersJson = {
  price: number;
  instance_hours: number;
};

type ibmAttributes = {
  provider: string;
  flavor: string;
  isolation: string;
  operating_system: string;
  ocp_included: boolean;
  catalog_region: string;
  server_type: string;
  billing_type: string;
  country: string;
  currency: string;
};

async function scrape(): Promise<void> {
  await downloadAll();
  
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function downloadAll(): Promise<void> {
  config.logger.info(`Downloading IBM VPC`);

  let resp: AxiosResponse | null = null;
  let success = false;
  let attempts = 0;

  do {
    try {
      attempts++;

      resp = await axios({
        method: 'get',
        url: `${baseUrl}/prices/?platform=all&country=USA`,
        headers: { 
          referer: 'https://cloud.ibm.com'
        }
      });
      success = true;
    } catch (err) {
      // Too many requests, sleep and retry
      if (err.response.status === 429) {
        config.logger.info(
          'Too many requests, sleeping for 30s and retrying'
        );
        await sleep(RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  } while (!success && attempts < MAX_RETRIES);

  if (!resp) {
    return;
  }

  try {
    const writer = fs.createWriteStream(filename);
    await writer.write(JSON.stringify(resp.data));
    writer.close();
  
  } catch (writeErr) {
    config.logger.error(
      `Skipping IBM instances due to error ${writeErr}.`
    );
  }
}


export default {
  scrape,
};
