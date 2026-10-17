export * as schema from './schema.js';
export { openDb, type Db, type DbHandle } from './client.js';
export { reviveCandidate, reviveMatch } from './serialize.js';
export {
  usersRepo,
  accountsRepo,
  oauthStatesRepo,
  type AccountRow,
  type OAuthStateRow,
} from './repos/accounts.js';
export { episodesRepo, matchesRepo, episodeToCandidate, type EpisodeRow } from './repos/catalog.js';
export {
  collectionsRepo,
  MAX_ITEMS_PER_COLLECTION,
  type CollectionRow,
  type CollectionItemRow,
} from './repos/collections.js';
export {
  exportsRepo,
  DbQuotaStore,
  itemRowToPlanItem,
  type ExportJobRow,
  type ExportItemRow,
} from './repos/exports.js';

import type { Db } from './client.js';
import { accountsRepo, oauthStatesRepo, usersRepo } from './repos/accounts.js';
import { episodesRepo, matchesRepo } from './repos/catalog.js';
import { collectionsRepo } from './repos/collections.js';
import { exportsRepo } from './repos/exports.js';

export function createRepos(db: Db) {
  return {
    users: usersRepo(db),
    accounts: accountsRepo(db),
    oauthStates: oauthStatesRepo(db),
    episodes: episodesRepo(db),
    matches: matchesRepo(db),
    collections: collectionsRepo(db),
    exports: exportsRepo(db),
  };
}
export type Repos = ReturnType<typeof createRepos>;
