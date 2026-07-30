/**
 * IDE/typecheck shims for Supabase Edge Functions.
 * Runtime resolution still uses Deno JSR/npm on Supabase; this only satisfies the editor TS server.
 */

declare module "jsr:@supabase/supabase-js@2" {
  export { createClient } from "@supabase/supabase-js";
  export type { SupabaseClient } from "@supabase/supabase-js";
}

declare module "npm:fast-json-stable-stringify@2.1.0" {
  export default function stringify(value: unknown): string;
}

declare module "node:crypto" {
  export function createHmac(
    algorithm: string,
    key: string | ArrayBufferView,
  ): {
    update(data: string | ArrayBufferView): { digest(encoding: "hex"): string };
  };
  export function timingSafeEqual(
    a: ArrayBufferView,
    b: ArrayBufferView,
  ): boolean;
}

declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): void;
};

declare const Buffer: {
  from(data: string, encoding?: string): Uint8Array;
};
