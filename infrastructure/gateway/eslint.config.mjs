import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: [".cloudflare/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
);
