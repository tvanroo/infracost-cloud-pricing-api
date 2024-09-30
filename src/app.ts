import express, { Application, Request, Response, NextFunction } from 'express';
import { ApolloServer, ApolloServerOptions, BaseContext } from '@apollo/server';
import { expressMiddleware } from '@apollo/server/express4';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerErrorCode } from '@apollo/server/errors';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { GraphQLError, GraphQLFormattedError } from 'graphql';
import pinoHttp from 'pino-http';
import path from 'path';
import { Logger } from 'pino';
import cors from 'cors';
import config from './config';
import ApolloLogger from './utils/apolloLogger';
import getResolvers from './resolvers';
import typeDefs from './typeDefs';
import health from './health';
import auth from './auth';
import events from './events';
import stats from './stats';
import home from './home';
import { Product } from './db/types';

export type ApplicationOptions<TContext> = {
  apolloConfigOverrides?: ApolloServer;
  disableRequestLogging?: boolean;
  disableStats?: boolean;
  disableAuth?: boolean;
  logger?: Logger;
  convertProducts?(context: TContext, products: Product[]): Promise<Product[]>;
};

interface ResponseError extends Error {
  status?: number;
}

async function createApp<TContext>(
  opts: ApplicationOptions<TContext> = {}
): Promise<Application> {
  const app = express();

  app.get('/liveness', (req, res) => {
    res.sendStatus(200);
  });

  app.get('/readiness', (req, res) => {
    res.sendStatus(200);
  });

  const logger = opts.logger || config.logger;

  if (!opts.disableRequestLogging) {
    app.use(
      pinoHttp({
        customLogLevel(_req, res, err) {
          if (err || res.statusCode === 500) {
            return 'error';
          }
          return 'info';
        },
        autoLogging: {
          ignore: (req) => req.url === '/health',
        },
        redact: {
          paths: ['req.headers["x-api-key"]']
        }
      })
    );
  }

  if (!opts.disableStats) {
    app.use(express.static(path.join(__dirname, 'public')));
    app.set('views', path.join(__dirname, 'views'));
    app.set('view engine', 'ejs');
    app.use(home);
  }

  app.use(express.json());
  app.use(
    (err: ResponseError, _req: Request, res: Response, next: NextFunction) => {
      if (err instanceof SyntaxError && err.status === 400) {
        res.status(400).send({ error: 'Bad request' });
      } else {
        next();
      }
    }
  );

  if (!opts.disableRequestLogging) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (!['/health', '/graphql'].includes(req.path)) {
        logger.debug({ body: req.body });
      }
      next();
    });
  }

  app.use(health);

  if (!opts.disableAuth) {
    app.use(auth);
  }

  if (!opts.disableStats) {
    app.use(events);
    app.use(stats);
  }

    // Big query objects with large keys or too many fields could trip this check
    app.use((req: Request, res: Response, next: NextFunction) => {
      const query = req.query.query || req.body.query || '';
      if (query.length > 2000) {
        res.status(400).json({
          status: 'error',
          message: 'Query too large'
        })
      } else {
        next();
      }
    });

  const errorFormatter = (formattedError: GraphQLFormattedError, err: unknown): GraphQLFormattedError => {
    const resp: GraphQLFormattedError = {
      message: formattedError.message
    };
    if (formattedError.extensions?.code === ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED) {
      throw new GraphQLError("Invalid Request", {
        extensions: {
          code: 'GRAPHQL_VALIDATION_FAILED'
        }
      })
    }
    return resp;
  };
  
  const apolloConfig: ApolloServerOptions<BaseContext> = {
    schema: makeExecutableSchema({
      typeDefs,
      resolvers: getResolvers<TContext>(opts),
    }),
    introspection: false,
    plugins: [
      ApolloServerPluginLandingPageDisabled(),
    ],
    cache: "bounded",
    allowBatchedHttpRequests: true,
    ...opts.apolloConfigOverrides,
  };

  apolloConfig.formatError = errorFormatter

  const apollo = new ApolloServer(apolloConfig);
  apollo.addPlugin(new ApolloLogger(logger));
  await apollo.start();

  app.use(
    '/graphql',
    cors<cors.CorsRequest>(),
    express.json(),
    expressMiddleware(apollo),
  );

  return app;
}

export default createApp;