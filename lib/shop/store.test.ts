import { shopStoreContract } from "./store.contract.ts";
import { MemoryShopStore } from "./store.ts";

shopStoreContract(async () => ({ store: new MemoryShopStore(), done: async () => {} }));
