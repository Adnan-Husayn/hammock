import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } from "@solana/web3.js";
import { createEd25519Instruction } from "@pythnetwork/pyth-lazer-solana-sdk";
import { startHarness, warpTo, fixturePayload, createScaledMint, scheduleMultiplier, uiAmount, sendTx, failed, SendResult, LAZER_PROGRAM_ID, LAZER_STORAGE, LAZER_TREASURY, TREASURY_LAMPORTS } from "./harness";

const disc = createHash("sha256").update("global:verify_message").digest().subarray(0, 8);

function verifyIx(payer: PublicKey, msg: Buffer): TransactionInstruction {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(msg.length);
  // ed25519_instruction_index u16 = 0, signature_index u8 = 0
  const data = Buffer.concat([disc, len, msg, Buffer.from([0, 0, 0])]);
  return new TransactionInstruction({
    programId: LAZER_PROGRAM_ID,
    data,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: LAZER_STORAGE, isSigner: false, isWritable: false },
      { pubkey: LAZER_TREASURY, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
  });
}

async function sendVerify(msg: Buffer) {
  const h = await startHarness();
  const before = h.context.getBalance(LAZER_TREASURY)!;
  const res = sendTx(h.context, h.payer, [createEd25519Instruction(msg, 1, 12), verifyIx(h.payer.publicKey, msg)]);
  const after = h.context.getBalance(LAZER_TREASURY)!;
  return { res, fee: after - before };
}

// Ed25519 precompile (instruction 0) fails with PrecompileError::InvalidSignature = Custom(2).
function expectSignatureFailure(res: SendResult) {
  expect(failed(res)).toBe(true);
  expect(res.toString()).toContain("err: InstructionError(0, Custom(2))");
}

describe("harness", () => {
  it("harness boots under the current Node", async () => {
    const h = await startHarness();
    expect(h.program.programId).toBeInstanceOf(PublicKey);
    await h.program.methods.ping().rpc();
    expect(h.context.getAccount(LAZER_PROGRAM_ID)?.executable).toBe(true);
    expect(h.context.getBalance(LAZER_TREASURY)).toBe(BigInt(TREASURY_LAMPORTS));
  });

  it("verifies a genuine fixture through the Lazer program", async () => {
    const msg = fixturePayload("regular-2026-10-29");
    expect(msg.length).toBe(158);
    const { res, fee } = await sendVerify(msg);
    expect(failed(res), failed(res) ? `${res.toString()}\n${res.meta().logs().join("\n")}` : "").toBe(false);
    expect(fee).toBe(1n);
  });

  it("rejects a tampered fixture", async () => {
    const msg = Buffer.from(fixturePayload("regular-2026-10-29"));
    msg[msg.length - 20] ^= 0x01;
    const { res, fee } = await sendVerify(msg);
    expectSignatureFailure(res);
    expect(fee).toBe(0n);
  });

  it("rejects a fixture whose signature bytes are corrupted but message is intact", async () => {
    const msg = Buffer.from(fixturePayload("regular-2026-10-29"));
    // Payload layout: magic u32 | signature [4..68) | pubkey [68..100) | len u16 | signed message [102..158).
    // The Ed25519 instruction reads the signature from these bytes inside the verify_message instruction.
    msg[4] ^= 0x01;
    expect(msg.subarray(102)).toEqual(fixturePayload("regular-2026-10-29").subarray(102));
    const { res, fee } = await sendVerify(msg);
    expectSignatureFailure(res);
    expect(fee).toBe(0n);
  });

  it("scaled mint reports multiplier 1.0 then 1.0025 after the scheduled timestamp", async () => {
    const h = await startHarness();
    const mint = await createScaledMint(h.context, { decimals: 8, multiplier: 1.0 });
    const now = Number(h.context.getClock().unixTimestamp);
    const effective = now + 3600;
    await scheduleMultiplier(h.context, mint, 1.0025, effective);
    expect(await uiAmount(h.context, mint, 100_000_000n)).toBe("1");
    await warpTo(h.context, effective + 1);
    expect(await uiAmount(h.context, mint, 100_000_000n)).toBe("1.0025");
  });
});
