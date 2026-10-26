import { multiTargetContract, receiveContract } from "./receive.contract.ts";
import { MemoryWitnessStore } from "./store.ts";

const memory = async (opts: ConstructorParameters<typeof MemoryWitnessStore>[0]) => ({ store: new MemoryWitnessStore(opts), done: async () => {} });
receiveContract(memory);
multiTargetContract(memory);
