import GlobalCatalogV1, {
  PricingGet,
} from '@ibm-cloud/platform-services/global-catalog/v1';
import { IamAuthenticator } from '@ibm-cloud/platform-services/auth';
import { writeFile } from 'fs/promises';
import _ from 'lodash';

import { Product, Price } from '../db/types';
import { generateProductHash } from '../db/helpers';
import { upsertProducts } from '../db/upsert';
import config from '../config';

const client = GlobalCatalogV1.newInstance({
  authenticator: new IamAuthenticator({
    apikey: config.ibmCloudApiKey as string,
  }),
});

const saasFileName = `data/ibm-catalog-saas.json`;
const iaasFileName = `data/ibm-catalog-iaas.json`;

type RecursiveNonNullable<T> = {
  [K in keyof T]-?: RecursiveNonNullable<NonNullable<T[K]>>;
};

type CatalogEntry = GlobalCatalogV1.CatalogEntry & {
  children: CatalogEntry[];
  pricingChildren?: PricingGet[];
};

type GCPrice = {
  price: number;
  quantity_tier: number;
};

type CompletePricingGet = PricingGet & {
  deployment_id?: string;
  deployment_location?: string;
  deployment_region?: string;
  effective_from?: string;
  effective_until?: string;
};

type UsageMetrics = {
  tierModel?: string;
  chargeUnitName?: string;
  chargeUnit?: string;
  chargeUnitQty?: string;
  usageCapQty?: number;
  displayCap?: number;
  effectiveFrom?: string;
  effectiveUntil?: string;
};

type AmountsRecord = Record<string, Record<string, GCPrice[]>>;
type MetricsRecord = Record<string, Omit<UsageMetrics, 'amounts'>>;

type AmountsAndMetrics = {
  amounts?: AmountsRecord;
  metrics?: MetricsRecord;
};

type PricingMetaData = AmountsAndMetrics & {
  type: string;
  region: string;
};

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
};

// https://cloud.ibm.com/docs/sell?topic=sell-meteringintera#pricing
export enum PricingModels {
  LINEAR = 'Linear',
  PRORATION = 'Proration',
  GRANULAR_TIER = 'Granular Tier',
  STEP_TIER = 'Step Tier',
  BLOCK_TIER = 'Block Tier',
}

// schema for attributes of IBM products
export type ibmAttributes = {
  planName?: string;
  planType?: string;
  startPrice?: string;
  startQuantityTier?: string;
  region?: string;
};

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
 * @param pricingObject
 * @returns
 */
function parsePricingJson(
  pricingObject: GlobalCatalogV1.PricingGet
): PricingMetaData | null {
  if (!('metrics' in pricingObject)) {
    return null;
  }
  const {
    type,
    deployment_location: region,
    metrics,
  } = pricingObject as RecursiveNonNullable<CompletePricingGet>;

  let amountAndMetrics: AmountsAndMetrics = { amounts: {}, metrics: {} };
  if (metrics?.length) {
    amountAndMetrics = metrics.reduce(
      (collection, metric: GlobalCatalogV1.Metrics): AmountsAndMetrics => {
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

        if (!collection.metrics) {
          return collection;
        }
        // eslint-disable-next-line no-param-reassign
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
            if (!collection.amounts) {
              return;
            }
            if (collection.amounts[key]) {
              // eslint-disable-next-line no-param-reassign
              collection.amounts[key][metricId] = amount.prices as GCPrice[];
            } else {
              // eslint-disable-next-line no-param-reassign
              collection.amounts[key] = {
                [metricId]: amount.prices as GCPrice[],
              };
            }
          }
        });
        return collection;
      },
      amountAndMetrics
    );
    return {
      type,
      region,
      ...amountAndMetrics,
    };
  }
  return {
    type,
    region,
  };
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
function getPrices(
  pricing: PricingMetaData,
  country: string,
  currency: string
): Price[] {
  let prices: Price[] = [];

  if (pricing) {
    const { metrics, amounts } = pricing;

    if (!metrics || !amounts) {
      return prices;
    }
    const geoKey = `${country}-${currency}`;
    prices = Object.entries(amounts[geoKey])
      .map(([partNumber, costs]): Price[] => {
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
          const { price, quantity_tier: quantityTier } = cost;

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
      })
      .flat();
  }
  return prices;
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
function getAttributes(
  pricing: PricingMetaData,
  planName: string
): ibmAttributes {
  if (!pricing) {
    return {};
  }

  const { type, region } = pricing;

  const attributes: ibmAttributes = {
    planName,
    planType: type,
    region,
  };

  return attributes;
}

/*
  service (group) - optional
  |
  |
  | 0..n
   - - - > service
           |
           | 
           | 0..n
            - - - > plan -> pricing might be here too, if not region specific
                   |
                   | 
                   | 0..n
                    - - - > deployment -> pricing might be here, if deployment specific <- pricing on previous level will be returned here too
*/
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
function parseProducts(services: CatalogEntry[]): Product[] {
  const products: Product[] = [];
  // for now, only grab USA, USD pricing
  const country = 'USA';
  const currency = 'USD';
  for (const service of services) {
    if (service.children) {
      if (service.group) {
        const productsOfGroup = parseProducts(service.children);
        products.push(...productsOfGroup);
      } else {
        for (const plan of service.children) {
          if (plan.children) {
            for (const deployment of plan.children) {
              if (deployment.pricingChildren) {
                for (const pricing of deployment.pricingChildren) {
                  const processedPricing = parsePricingJson(pricing);
                  if (!processedPricing) {
                    continue;
                  }
                  const prices = getPrices(processedPricing, country, currency);
                  const attributes = getAttributes(processedPricing, plan.name);
                  const region = attributes?.region || country;

                  if (prices?.length) {
                    const p = {
                      productHash: ``,
                      sku: `${service.name}-${plan.name}`,
                      vendorName: 'ibm',
                      region,
                      service: service.name,
                      productFamily: 'service',
                      attributes,
                      prices,
                    };
                    p.productHash = generateProductHash(p);
                    products.push(p);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return products;
}

/*
  iaas (group) - optional
  |
  |
  | 0..n
   - - - > iaas
           |
           | 
           | 0..n
            - - - > plan - possibly priced (for satellite i.e cos satellite plan)
                    |
                    |
                    | 0..n
                     - - - > deployment - possibly  priced
                             |
                             |
                             | 0..n
                              - - - > plan - possibly priced
                                      |
                                      |
                                      | 0..n
                                       - - - > deployment - possibly priced
*/
function parseIaaSProducts(infrastructure: CatalogEntry[]): Product[] {
  const products: Product[] = [];
  // for now, only grab USA, USD pricing
  const country = 'USA';
  const currency = 'USD';
  for (const iaas of infrastructure) {
    if (iaas.children) {
      if (iaas.group) {
        const productsOfGroup = parseIaaSProducts(iaas.children);
        products.push(...productsOfGroup);
      } else {
        for (const plan of iaas.children) {
          if (plan.children) {
            for (const deployment of plan.children) {
              if (deployment.pricingChildren) {
                for (const pricing of deployment.pricingChildren) {
                  const processedPricing = parsePricingJson(pricing);
                  if (!processedPricing) {
                    continue;
                  }
                  const prices = getPrices(processedPricing, country, currency);
                  const attributes = getAttributes(processedPricing, plan.name);
                  const region = attributes?.region || country;

                  if (prices?.length) {
                    const p = {
                      productHash: ``,
                      sku: `${iaas.name}-${plan.name}`,
                      vendorName: 'ibm',
                      region,
                      service: iaas.name,
                      productFamily: 'iaas',
                      attributes,
                      prices,
                    };
                    p.productHash = generateProductHash(p);
                    products.push(p);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return products;
}

// q: 'kind:service active:true price:paygo',
const serviceParams = {
  q: 'kind:service active:true',
  include: 'id:geo_tags:kind:name:pricing_tags:tags',
};

const infrastuctureParams = {
  q: 'kind:iaas active:true',
  include: 'id:geo_tags:kind:name:pricing_tags:tags',
};

async function getCatalogEntries(
  globalCatalog: GlobalCatalogV1,
  params: Pick<
    GlobalCatalogV1.ListCatalogEntriesParams,
    'account' | 'q' | 'include'
  >
): Promise<GlobalCatalogV1.CatalogEntry[]> {
  const limit = 200;
  let offset = 0;
  let next = true;
  const servicesArray = [];

  while (next) {
    const response = await globalCatalog.listCatalogEntries({
      ...params,
      limit,
      offset,
    });
    if (response.result?.resources?.length) {
      servicesArray.push(...response.result.resources);
    }
    if (!response.result.count || offset > response.result.count) {
      next = false;
    }
    offset += limit;
  }
  return servicesArray;
}

async function fetchPricingForProduct(
  client: GlobalCatalogV1,
  product: GlobalCatalogV1.CatalogEntry
): Promise<CatalogEntry> {
  const tree = (
    await client.getCatalogEntry({
      id: product.id as string,
      depth: 10,
      include: 'id:kind:name:tags:pricing_tags:geo_tags:meatadata',
    })
  ).result as CatalogEntry;
  const stack = [tree];
  while (stack.length > 0) {
    // Couldn't get here if the were no elems on the stack
    const currentElem = stack.pop() as CatalogEntry;
    // For example satellite located deployments area also priced on the plan level
    if (currentElem.kind === 'plan' && currentElem.children) {
      const deploymentChildren = currentElem.children.filter(
        (child) => child.kind === 'deployment'
      );
      const chunks = _.chunk([currentElem, ...deploymentChildren], 8);
      for (const elements of chunks) {
        await Promise.all(
          elements.map(async (element): Promise<void> => {
            try {
              const pricingObject = (
                await client.getChildObjects({
                  id: element.id as string,
                  kind: 'pricing',
                })
              ).result as PricingGet;
              if (!pricingObject) {
                return;
              }
              // eslint-disable-next-line no-param-reassign
              element.pricingChildren = [pricingObject];
            } catch (e) {
              if (!e?.code || e?.code !== 404) {
                config.logger.error(e?.message);
              }
            }
          })
        );
      }
    }
    if (currentElem.children && currentElem.children.length > 0) {
      for (const child of currentElem.children) {
        stack.push(child);
      }
    }
  }
  return tree;
}

async function scrape(): Promise<void> {
  config.logger.info(`Started IBM Cloud scraping at ${new Date()}`);
  const saasResults: CatalogEntry[] = [];
  const iaasResults: CatalogEntry[] = [];

  const serviceEntries = await getCatalogEntries(client, {
    ...serviceParams,
    account: 'global',
  });

  for (const service of serviceEntries) {
    config.logger.info(`Scraping pricing for ${service.name}`);
    const tree = await fetchPricingForProduct(client, service);
    saasResults.push(tree);
  }
  await writeFile(saasFileName, JSON.stringify(saasResults, null, 2));
  const saasProducts = parseProducts(saasResults);
  await writeFile(
    'ibm-saas-products.json',
    JSON.stringify(saasProducts, null, 2)
  );

  const infrastructureEntries = await getCatalogEntries(client, {
    ...infrastuctureParams,
    account: 'global',
  });

  for (const infra of infrastructureEntries) {
    config.logger.info(`Scraping pricing for ${infra.name}`);
    const tree = await fetchPricingForProduct(client, infra);
    iaasResults.push(tree);
  }

  await writeFile(iaasFileName, JSON.stringify(iaasResults, null, 2));
  const iaasProducts = parseIaaSProducts(iaasResults);
  await writeFile(
    'ibm-iaas-products.json',
    JSON.stringify(iaasProducts, null, 2)
  );

  await upsertProducts(saasProducts);
  await upsertProducts(iaasProducts);

  config.logger.info(`Ended IBM Cloud scraping at ${new Date()}`);
}

export default {
  scrape,
};
