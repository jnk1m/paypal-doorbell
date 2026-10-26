import { storeContract } from "./store.contract.ts";
import { MemoryWitnessStore } from "./store.ts";

storeContract(async (opts) => ({ store: new MemoryWitnessStore(opts), done: async () => {} }));
