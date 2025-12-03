import { math, isEnabled } from '~/utils';

/**
 * Centralized configuration for MCP-related environment variables.
 * Provides typed access to MCP settings with default values.
 */
export const mcpConfig = {
  OAUTH_ON_AUTH_ERROR: isEnabled(process.env.MCP_OAUTH_ON_AUTH_ERROR ?? true),
  OAUTH_DETECTION_TIMEOUT: math(process.env.MCP_OAUTH_DETECTION_TIMEOUT ?? 5000),
  CONNECTION_CHECK_TTL: math(process.env.MCP_CONNECTION_CHECK_TTL ?? 60000),
  DEFAULT_TIMEOUT_MS: math(process.env.MCP_DEFAULT_TIMEOUT_MS ?? 300000),
};
