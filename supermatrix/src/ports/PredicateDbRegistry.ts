export type PredicateDbConnection = {
  dbRef: string;
  kind: "sqlite";
  path: string;
  readonly: boolean;
  mode?: string;
};

export type PredicateDbRegistry = {
  resolve(dbRef: string): PredicateDbConnection | undefined;
};
