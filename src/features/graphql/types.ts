// GraphQL Introspection Types

export interface GraphQLType {
  kind: GraphQLTypeKind;
  name: string | null;
  description: string | null;
  fields: GraphQLField[] | null;
  inputFields: GraphQLInputValue[] | null;
  interfaces: GraphQLTypeRef[] | null;
  enumValues: GraphQLEnumValue[] | null;
  possibleTypes: GraphQLTypeRef[] | null;
  ofType: GraphQLTypeRef | null;
}

export type GraphQLTypeKind =
  | 'SCALAR'
  | 'OBJECT'
  | 'INTERFACE'
  | 'UNION'
  | 'ENUM'
  | 'INPUT_OBJECT'
  | 'LIST'
  | 'NON_NULL';

export interface GraphQLTypeRef {
  kind: GraphQLTypeKind;
  name: string | null;
  ofType: GraphQLTypeRef | null;
}

export interface GraphQLField {
  name: string;
  description: string | null;
  args: GraphQLInputValue[];
  type: GraphQLTypeRef;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

export interface GraphQLInputValue {
  name: string;
  description: string | null;
  type: GraphQLTypeRef;
  defaultValue: string | null;
}

export interface GraphQLEnumValue {
  name: string;
  description: string | null;
  isDeprecated: boolean;
  deprecationReason: string | null;
}

export interface GraphQLDirective {
  name: string;
  description: string | null;
  locations: string[];
  args: GraphQLInputValue[];
}

export interface GraphQLSchema {
  queryType: GraphQLTypeRef | null;
  mutationType: GraphQLTypeRef | null;
  subscriptionType: GraphQLTypeRef | null;
  types: GraphQLType[];
  directives: GraphQLDirective[];
}

export interface IntrospectionResult {
  success: boolean;
  schema: GraphQLSchema | null;
  error?: string;
  endpoint: string;
  timestamp: number;
}

// Parsed variable from GraphQL query
export interface GraphQLVariable {
  name: string;
  type: string;
  isRequired: boolean;
  defaultValue?: string;
}

// Helper to get the base type name from a type reference
export function getTypeName(typeRef: GraphQLTypeRef): string {
  if (typeRef.name) {
    return typeRef.name;
  }
  if (typeRef.ofType) {
    return getTypeName(typeRef.ofType);
  }
  return 'Unknown';
}

// Helper to format type reference as string (e.g., "[String!]!")
export function formatTypeRef(typeRef: GraphQLTypeRef): string {
  if (typeRef.kind === 'NON_NULL') {
    return `${formatTypeRef(typeRef.ofType!)}!`;
  }
  if (typeRef.kind === 'LIST') {
    return `[${formatTypeRef(typeRef.ofType!)}]`;
  }
  return typeRef.name || 'Unknown';
}
