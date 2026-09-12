import { MockPlatform } from '../../../../packages/mock-service/src/index';
import { createDemoFetcher } from '../../../../packages/mock-service/src/demo-fetch';
import type { DemoPlatform } from '../../../../packages/contracts/src/index';
import { HttpPlatform } from '../../../../packages/http-platform/src/index';

/** HTTP is an explicit local development mode; production retains the demo facade. */
export const platform: DemoPlatform = import.meta.env.DEV && import.meta.env.MODE === 'local-http' && import.meta.env.LOCAL_HTTP_SERVE === true
  ? new HttpPlatform({ baseUrl: '/api' })
  : new MockPlatform({
  fetcher: createDemoFetcher(import.meta.env.BASE_URL),
});
