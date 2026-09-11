import { MockPlatform } from '../../../../packages/mock-service/src/index';
import { createDemoFetcher } from '../../../../packages/mock-service/src/demo-fetch';
import type { DemoPlatform } from '../../../../packages/contracts/src/index';

/** Replace this one composition root with an HTTP adapter when B2 is authorized. */
export const platform: DemoPlatform = new MockPlatform({
  fetcher: createDemoFetcher(import.meta.env.BASE_URL),
});
