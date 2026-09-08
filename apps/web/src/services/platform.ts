import { MockPlatform } from '../../../../packages/mock-service/src/index';
import type { DemoPlatform } from '../../../../packages/contracts/src/index';

/** Replace this one composition root with an HTTP adapter when B2 is authorized. */
export const platform: DemoPlatform = new MockPlatform();
