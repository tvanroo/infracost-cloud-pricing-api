import GlobalCatalogV1, { CatalogEntry, PricingGet } from '@ibm-cloud/platform-services/global-catalog/v1';
import { writeFile } from 'fs/promises';

import { Product, Price } from '../db/types';
import { generateProductHash } from '../db/helpers';
import { upsertProducts } from '../db/upsert';
import config from '../config';


const client = GlobalCatalogV1.newInstance({});
const filename = `data/ibm-catalog.json`;

type CatalogJson = {
  [name: string]: (CatalogJson | PricingMetaData)[]
}

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

// https://cloud.ibm.com/docs/sell?topic=sell-meteringintera#pricing
export enum PricingModels {
  LINEAR = 'Linear',
  PRORATION = 'Proration',
  GRANULAR_TIER = 'Granular Tier',
  STEP_TIER = 'Step Tier',
  BLOCK_TIER = 'Block Tier'
};

// schema for attributes of IBM products
export type ibmAttributes = {
  planName?: string,
  planType?: string,
  startPrice?: string,
  startQuantityTier?: string,
  region?: string,
};


const globalCatalogHierarchy: Record<string, string> = {
  service: 'plan',
  plan: 'deployment',
  deployment: 'pricing',
  iaas: 'iaas',
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
    const {id, name, kind, disabled} = service;
    if (!id || disabled) {
      config.logger.info(`service is undefined or disabled. Skipping.`)
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

/**
 * Flattens the tree of pricing info for a plan, as each plan can describe multiple charge models (Metric).
 * A charge model describes the pricing model (tier), the unit, a quantity, and the part number to charge against.
 * Multiple charge models can be in use at one time, which would translate to multiple cost components for a product.
 * 
 * The pricing for each country-currency combination is available for each Metric in an 'amounts' array. Any thresholds
 * for tiered pricing models are defined with the price for each country-currency.
 * 
 * Pricing for a plan:
 * - plan type
 * - Metrics [] (by part number and tier model)
 *   - tierModel
 *   - unit
 *   - quantity
 *   - part number
 *   - Amounts [] (by country and currency)
 *     - quantity threshold
 *     - price
 * 
 * @param input 
 * @returns 
 */
function parsePricingJson(input: GlobalCatalogV1.EntrySearchResult | GlobalCatalogV1.PricingGet): Record<string, unknown> {
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
  return {
    type,
    region,
    startingPrice,
  };
}

// q: 'kind:service active:true price:paygo',
const serviceParams = {
  q: 'kind:service active:true',
  limit: 5,
  include: 'id:geo_tags:kind:name:pricing_tags'
};

const infrastuctureQuery = {
  q: 'kind:iaas active:true',
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

/** 
 * Price Mapping:
 * DB Price:           | ibmCatalogJson:
 * ------------------- | -------------------------
 * priceHash:          | (unit-purchaseOption-country-currency-startUsageAmount-partNumber)
 * purchaseOption:     | chargeUnitQty
 * unit:               | chargeUnitName
 * tierModel:          | PricingMetaData.metrics[partNumber].tierModel
 * USD?:               | PricingMetaData.amounts[geo].costs.price
 * CNY?:               | NOT USED
 * effectiveDateStart: | PricingMetaData.metrics[partNumber].effectiveFrom
 * effectiveDateEnd:   | PricingMetaData.metrics[partNumber].effectiveUntil
 * startUsageAmount:   | NOT USED
 * endUsageAmount:     | quantityTier
 * termLength:         | NOT USED
 * termPurchaseOption  | NOT USED
 * termOfferingClass   | NOT USED
 * description         | chargeUnit
 * country             | country
 * currency            | currency
 * partNumber          | partNumber
 * 
 * @param currency https://www.ibm.com/support/pages/currency-code-9comibmhelpsppartneruserdocsaasspcurrencycodehtml
 * 
 * @returns an empty array if no pricing found
 */
function getPrices(pricing: PricingMetaData, country: string, currency: string): Price[] {
  let prices: Price[] = []

  if (pricing) {
    const {
      metrics,
      amounts,
    } = pricing;

    if (!metrics) {
      return prices;
    }
    const geoKey = `${country}-${currency}`
    prices = Object.entries(amounts[geoKey]).map(([partNumber, costs]): Price[] => {
      const {
        tierModel,
        chargeUnitName,
        chargeUnit,
        chargeUnitQty,
        // usageCapQty,
        // displayCap,
        effectiveFrom,
        effectiveUntil,
      } = metrics[partNumber];

      return costs.map((cost: GCPrice): Price => {
        const {
          price,
          quantity_tier: quantityTier,
        } = cost;

        return {
          priceHash: `${chargeUnitName}-${chargeUnitQty}-${country}-${currency}-${quantityTier}-${partNumber}`,
          purchaseOption: String(chargeUnitQty),
          USD: String(price),
          endUsageAmount: String(quantityTier),
          tierModel,
          // usageCapQty,
          // displayCap,
          description: chargeUnit,
          unit: chargeUnitName ?? '',
          effectiveDateStart: effectiveFrom ?? new Date().toISOString(),
          effectiveDateEnd: effectiveUntil,
          country,
          currency,
          partNumber,
        };
      });
    }).flat();
  }
  return prices
} 

/**
 * Schema for IBM product Attributes from global catalog
 * ibmAttributes     | CatalogEntryMetadataPricing
 * ----------------- | ----------------------------
 * planName          | id (Global Catalog serviceId)
 * planType          | type (https://cloud.ibm.com/docs/account?topic=account-accounts)
 * startingPrice     | startingPrice
 * startQuantityTier | startQuantityTier
 * region            | region
 * 
 * @param pricing 
 * @returns 
 */
function getAttributes(pricing: PricingMetaData, planName: string): ibmAttributes {
  if (!pricing) {
    return {}
  }

  const {
    startingPrice,
    type,
    region,
  } = pricing;

  const {
    price: startPrice,
    quantity_tier: startQuantityTier,
  } = startingPrice;
  
  const attributes: ibmAttributes = {
    planName,
    planType: type,
    startPrice: String(startPrice),
    startQuantityTier: String(startQuantityTier),
    region,
  };

  return attributes;
};

/**
 * Global Catalog is an hierarchy of things, of which we are interested in 'services' and 'iaas' kinds on the root.
 * 
 * Root:
 * | service
 *   - plans []
 *     - deployments [] (by region)
 *       - region
 *       - amounts [] (by country-currency)
 *         - part number
 *           - price
 *           - quantity threshold
 *       - metrics [] (by part number)
 *         - tier
 *         - unit
 *         - effective dates
 * 
 *  | iaas
 *    - 
 * 
 * Product Mapping:
 * DB:             | CatalogJson:
 * --------------- | -----------------
 * productHash:    | md5(vendorName + region + sku);
 * sku:            | service - plan_id
 * vendorName:     | 'ibm'
 * region:         | PricingMetaData.region || country
 * service:        | serviceName
 * productFamily:  | 'service'
 * attributes:     | ibmAttributes
 * prices:         | Price[]
 *
 * @param services 
 * @returns 
 */
function parseProducts(services: CatalogJson[]): Product[] {
  const products: Product[] = [];
  // for now, only grab USA, USD pricing
  const country = 'USA'
  const currency = 'USD'
  services.forEach((service) => {
    Object.entries(service).forEach(([serviceId, plans]) => {
      if (!plans?.length) {
        return;
      }
      plans.forEach((plan) => {
        Object.entries(plan).forEach(([planName, deployments]: [string, (CatalogJson | AmountsAndMetrics)[]]) => {
          if (!deployments?.length) {
            return;
          }
          deployments.forEach((deployment) => {
            Object.entries(deployment).forEach(([, pricing]) => {
                const prices = getPrices(pricing?.[0], country, currency);
                const attributes = getAttributes(pricing?.[0], planName);
                const region = attributes?.region || country;

                if (prices?.length) {
                  const p = {
                    productHash: ``,
                    sku: `${serviceId}-${planName}`,
                    vendorName: 'ibm',
                    region,
                    service: serviceId,
                    productFamily: 'service',
                    attributes,
                    prices,
                  }
                  p.productHash = generateProductHash(p);
                  products.push(p)
                }
            });
          })
        });
      })
    })
  });
  return products;
}

async function scrape(): Promise<void> {
  const start = queryCatalogItems.bind(null, serviceParams, parsePricingJson);
  const results = await download(start);
  writeFile(filename, JSON.stringify(results, null, 2));
  const products = parseProducts(results as CatalogJson[]);
  writeFile('products.json', JSON.stringify(products, null, 2));
  await upsertProducts(products);
  config.logger.info("-------- ALL DONE -------")
}

export default {
  scrape,
};
