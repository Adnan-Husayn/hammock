import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
afterEach(cleanup);
// jsdom swaps in its own Uint8Array; Node's Buffer and the hash library must agree on one.
globalThis.Uint8Array = Object.getPrototypeOf(Buffer.prototype).constructor;
