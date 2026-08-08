import { Pool, type PoolConfig } from 'pg'

/**
 * Single place pg connection pools are constructed. Sans-IO callers pass a
 * connection string explicitly; nothing here reads the environment.
 */
export function createPool(
  connectionString: string,
  config: Omit<PoolConfig, 'connectionString'> = {},
): Pool {
  return new Pool({ connectionString, ...config })
}
