import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLError,
} from 'graphql';

/**
 * Real GraphQL schema (graphql-js). Used by the mock HTTP server's
 * `/graphql` endpoint and shared with the WebSocket subscription server.
 *
 * Resolvers are intentionally tiny — they exist to give E2E tests a real
 * `graphql.execute()` round-trip rather than regex-matching query strings.
 */

interface User {
  id: string;
  name: string;
}

const userStore = new Map<string, User>([
  ['1', { id: '1', name: 'Ada Lovelace' }],
  ['2', { id: '2', name: 'Grace Hopper' }],
]);

const UserType = new GraphQLObjectType({
  name: 'User',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    name: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const TickType = new GraphQLObjectType({
  name: 'Tick',
  fields: {
    n: { type: new GraphQLNonNull(GraphQLInt) },
    timestamp: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    hello: {
      type: GraphQLString,
      args: { name: { type: GraphQLString } },
      resolve(_root, args: { name?: string }) {
        return `Hello, ${args.name ?? 'world'}!`;
      },
    },
    user: {
      type: UserType,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve(_root, args: { id: string }) {
        return userStore.get(args.id) ?? null;
      },
    },
    users: {
      type: new GraphQLList(UserType),
      resolve() {
        return Array.from(userStore.values());
      },
    },
    // Throws so tests can exercise the error-with-extensions path.
    boom: {
      type: GraphQLString,
      args: { message: { type: GraphQLString } },
      resolve(_root, args: { message?: string }) {
        throw new GraphQLError(args.message ?? 'kaboom', {
          extensions: { code: 'BOOM_HAPPENED', http: { status: 418 } },
        });
      },
    },
    // Returns partial data — mixed nullable success + error in a sibling list.
    // Each list element resolves through its own Promise so a single failure
    // nulls just that index instead of nulling the whole list.
    partial: {
      type: new GraphQLList(UserType),
      args: { ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) } },
      resolve(_root, args: { ids: string[] }) {
        return args.ids.map(async (id) => {
          const user = userStore.get(id);
          if (!user) {
            throw new GraphQLError(`user ${id} not found`, {
              extensions: { code: 'NOT_FOUND', id },
            });
          }
          return user;
        });
      },
    },
  },
});

const MutationType = new GraphQLObjectType({
  name: 'Mutation',
  fields: {
    createUser: {
      type: UserType,
      args: { name: { type: new GraphQLNonNull(GraphQLString) } },
      resolve(_root, args: { name: string }) {
        const id = String(userStore.size + 1);
        const user: User = { id, name: args.name };
        userStore.set(id, user);
        return user;
      },
    },
  },
});

const SubscriptionType = new GraphQLObjectType({
  name: 'Subscription',
  fields: {
    tick: {
      type: TickType,
      args: { count: { type: GraphQLInt } },
      // Emits N ticks (default 3) once per subscription.
      async *subscribe(_root, args: { count?: number }) {
        const total = Math.min(Math.max(args.count ?? 3, 1), 10);
        for (let i = 0; i < total; i += 1) {
          yield { tick: { n: i, timestamp: new Date(0).toISOString() } };
        }
      },
    },
  },
});

export const schema = new GraphQLSchema({
  query: QueryType,
  mutation: MutationType,
  subscription: SubscriptionType,
});
