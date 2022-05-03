import GlobalCatalogV1, { CatalogEntry,PricingGet } from '@ibm-cloud/platform-services/global-catalog/v1';
import { writeFile } from 'fs/promises';

import { Product, Price } from '../db/types';
// import { generateProductHash, generatePriceHash } from '../db/helpers';
import { upsertProducts } from '../db/upsert';
import config from '../config';

const iamType = process.env.GLOBAL_CATALOG_AUTHTYPE;
const apiKey = process.env.GLOBAL_CATALOG_APIKEY;

const client = GlobalCatalogV1.newInstance({
  serviceName: 'global_catalog',
  serviceUrl: 'https://globalcatalog.cloud.ibm.com/api/v1'
});

type GCPrice = {
  price: number;
  quantity_tier: number;
}

type ResultsWithNext<Results extends Record<string, unknown> = Record<string, unknown>> = {
  results: Results[],
  next?: () => Promise<ResultsWithNext<Results>>
}

type CompletePricingGet = PricingGet & {
  deployment_id?: string;
  deployment_location?: string;
  deployment_region?: string;
  effective_from?: string;
  effective_until?: string;
}
// generate and IAM token from an ApiKey

// const IBM_DEFAULTS = {
//   iamHost: 'https://iam.cloud.ibm.com',
// };

type UsageMetrics  = {
  tierModel?: string;
  chargeUnitName?: string;
  chargeUnit?: string;
  chargeUnitQty?: string;
  usageCapQty?: number;
  displayCap?: number;
  effectiveFrom?: string;
  effectiveUntil?: string;
}


type AmountsRecord = Record<string, Record<string, GCPrice[]>>
type MetricsRecord = Record<string, Omit<UsageMetrics, "amounts">>

type AmountsAndMetrics = {
  amounts: AmountsRecord;
  metrics: MetricsRecord;
}
type PricingMetaData = AmountsAndMetrics & {
  type: string;
  region: string;
  startingPrice: GCPrice,
}

// const baseUrl = 'https://globalcatalog.cloud.ibm.com/api/v1';

// async function scrape(): Promise<void> {
//   await downloadAll();
//   // await loadAll();
// }

export type Service = {
  id?: string;
  name?: string;
  plans?: (Plan | undefined)[];
};

export type Plan = {
  id?: string;
  name?: string;
  deployments?: (Deployment | undefined)[];
};

export type Deployment = {
  id?: string;
  name?: string;
  geo_tags?: string[];
  // deployments: Deployment[];
};

// async function getIbmCloudAccessToken(): Promise<string> {
//   const {iamHost, apikey} = {...IBM_DEFAULTS, ...config?.ibm } ;
//   /* eslint-disable camelcase */
//   const payload = {
//     grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
//     response_type: 'cloud_iam',
//     apikey,
//   };
//   /* eslint-enable camelcase */
//   const data = querystring.stringify(payload);
//   const requestConfig: AxiosRequestConfig = {
//     url: `${iamHost}/identity/token`,
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/x-www-form-urlencoded',
//       Accept: 'application/json',
//     },
//     data,
//   };
//   const response = await axios(requestConfig);
//   if (response.data?.access_token) {
//     return response.data?.access_token as string;
//   }
//   throw new Error(response.data);
// }

const globalCatalogHierarchy: Record<string, string> = {
  service: 'plan',
  plan: 'deployment',
  deployment: 'pricing',
}

function nextKind(kind:string): string {
  return globalCatalogHierarchy[kind];
}

async function queryCatalogItems<Result extends Record<string, unknown> = Record<string, unknown>>(params: GlobalCatalogV1.ListCatalogEntriesParams | GlobalCatalogV1.GetChildObjectsParams, processLeaf?: (input: GlobalCatalogV1.EntrySearchResult | GlobalCatalogV1.PricingGet) => Record<string, unknown>): Promise<ResultsWithNext<Result>> {
  let response: GlobalCatalogV1.Response<GlobalCatalogV1.EntrySearchResult>;
  if ('id' in params) {
    response = await client.getChildObjects(params);
  } else {
    response = await client.listCatalogEntries(params);
  }

  if (response.status >= 400) {
    config.logger.error(`Received status ${response.status} from IBM Cloud global catalog.`)
    throw new Error();
  }
  if (! response?.result) {
    config.logger.error(`No result in response: ${JSON.stringify(response)}`)
    throw new Error();
  }

  if (!response?.result?.resources) {
    if (processLeaf) {
      return {
        results: [processLeaf(response?.result)] as Result[],
      };
    }
    return {
      results: [response?.result] as Result[],
    };
  }
  const services = response?.result?.resources;
  const products = await Promise.all(services.map(async (service: CatalogEntry): Promise<Result> => {
    const {id, name, kind} = service;
    if (!id) {
      config.logger.info(`service is undefined`)
      return {
        [name]: []
      } as Result;
    }
    if (nextKind(kind)) {
      const children = await download(() => 
        queryCatalogItems({
          id,
          kind: nextKind(kind),
        }, processLeaf)
      );

      return {
        [name]: children,
      } as Result;
    }
    return {
      [name]: null,
    } as Result;
  })).catch((e) => {
    console.info(e);
  });
  const {
    resource_count: resourceCount,
    count,
    offset,
  } = response.result;
  if (products && typeof count === 'number' && typeof offset === 'number' && typeof resourceCount === 'number') {
    config.logger.info(`${products.map((p) => Object.keys(p))}: ${offset + resourceCount} of ${count}`);
    if (offset + resourceCount < count) {
      return {
        results: products as Result[],
        next() {
          return queryCatalogItems<Result>({
            ...params,
            offset: offset + resourceCount,
          }, processLeaf);
        },
      }
    }
  }
  config.logger.info(`FINISHED`);
  return {
    results: products as Result[],
  }
}

function extractPricingInfo(input: GlobalCatalogV1.EntrySearchResult | GlobalCatalogV1.PricingGet): Record<string, unknown> {
  if (!('metrics' in input)) {
    return {}
  }
  const {
    type,
    deployment_location: region,
    starting_price: startingPrice,
    metrics,
  } = input as CompletePricingGet;
  let amountAndMetrics: AmountsAndMetrics = {amounts: {}, metrics: {}};
  if (metrics?.length) {
    amountAndMetrics = metrics.reduce((collection: AmountsAndMetrics, metric: GlobalCatalogV1.Metrics): AmountsAndMetrics => {
      const {
        metric_id: metricId,
        amounts,
        tier_model: tierModel,
        charge_unit_name: chargeUnitName,
        charge_unit: chargeUnit,
        charge_unit_quantity: chargeUnitQty,
        usage_cap_qty: usageCapQty,
        display_cap: displayCap,
        effective_from: effectiveFrom,
        effective_until: effectiveUntil,
      } = metric;
      if (!metricId) {
        return collection;
      }
      collection.metrics[metricId] = {
        tierModel,
        chargeUnitName,
        chargeUnit,
        chargeUnitQty,
        usageCapQty,
        displayCap,
        effectiveFrom,
        effectiveUntil,
      };
      amounts?.forEach((amount) => {
        if (amount?.prices?.length && amount?.country && amount?.currency) {
          const key = `${amount.country}-${amount.currency}`;
          if (collection.amounts[key]) {
            collection.amounts[key][metricId] = amount.prices as GCPrice[];
          } else {
            collection.amounts[key] = {[metricId]: amount.prices as GCPrice[]};
          }
        }
      })
      return collection;
    }, amountAndMetrics);
    return {
      type,
      region,
      startingPrice,
      ...amountAndMetrics
    };
  }
  // console.info(JSON.stringify(amountAndMetrics, null, 2))
  return {
    type,
    region,
    startingPrice,
  };
}

const serviceParams = {
  q: 'kind:service active:true price:paygo',
  limit: 5,
  include: 'id:geo_tags:kind:name:pricing_tags'
};

async function download(query: () => Promise<ResultsWithNext>): Promise<Record<string,unknown>[]> {
  try {
    // const accessToken = await getIbmCloudAccessToken();
    const products = await query();
    
    if (products.next) {
      return [...products.results, ...(await download(products.next))];
    }
    return products.results;
  } catch (e) {
    config.logger.error((e as Error).message);
    return [];
  }
}

type CatalogMapping = {
  [name: string]: (CatalogMapping | PricingMetaData)[]
}

function cleanAndFormatData(services: CatalogMapping[]): Product[] {
  const products: Product[] = [];
  services.forEach((service) => {
    Object.entries(service).forEach(([serviceName, plans]) => {
      if (!plans?.length) {
        return;
      }
      plans.forEach((plan) => {
        Object.entries(plan).forEach(([planName, deployments]: [string, (CatalogMapping | AmountsAndMetrics)[]]) => {
          if (!deployments?.length) {
            return;
          }
          deployments.forEach((deployment) => {
            Object.entries(deployment).forEach(([, pricing]) => {
              if (pricing?.[0]) {
                const amountsAndMetrics = pricing[0] as PricingMetaData;
                const {
                  startingPrice,
                  amounts,
                  region,
                  metrics,
                  type,
                } = amountsAndMetrics;
                if (!metrics) {
                  return;
                }
                const {
                  price: startPrice,
                  quantity_tier: startQuantityTier,
                } = startingPrice;
                const prices = Object.entries(amounts['USA-USD']).map(([code, costs]): Price[] => {
                  const {
                    tierModel,
                    // chargeUnitName: unitName,
                    chargeUnit: unit,
                    // chargeUnitQty,
                    // usageCapQty,
                    // displayCap,
                    effectiveFrom,
                    effectiveUntil,
                  } = metrics[code];
                  return costs.map((cost: GCPrice): Price => {
                    const {
                      price,
                      quantity_tier: quantityTier,
                    } = cost;
                    return {
                      startPrice,
                      startQuantityTier,
                      priceHash: `USA-USD-${quantityTier}`,
                      purchaseOption: '',
                      code,
                      price,
                      quantityTier,
                      tierModel,
                      // chargeUnitQty,
                      // usageCapQty,
                      // displayCap,
                      unit: unit ?? '',
                      effectiveDateStart: effectiveFrom ?? new Date().toISOString(),
                      effectiveDateEnd: effectiveUntil,
                    };
                  });
                }).flat();
                if (prices?.length) {
                  products.push({
                    productHash: `${serviceName}-${planName}-${region}-USA-USD`,
                    sku: `${planName}`,
                    vendorName: 'ibm',
                    region,
                    service: serviceName,
                    productFamily: 'service',
                    attributes: {
                      type,
                    },
                    prices,
                  })
                }
              }
            });
          })
        });
      })
    })
  });
  return products;
}
// (async function scrape(): Promise<void> {
//   const results = await queryCatalogItems(serviceParams, extractPricingInfo);
//   config.logger.info(JSON.stringify(results.results));
// })();


async function scrape(): Promise<void> {
  const start = queryCatalogItems.bind(null, serviceParams, extractPricingInfo);
  const results = await download(start);
  writeFile('results.json', JSON.stringify(results, null, 2));
  const products = cleanAndFormatData(results as CatalogMapping[]);
  writeFile('products.json', JSON.stringify(products, null, 2));
  await upsertProducts(products);
  config.logger.info("-------- ALL DONE -------")
}

export default {
  scrape,
};
