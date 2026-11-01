// Register on the client's instance: pnpm peer variants can hold separate extension maps.
export function registerAssemblyExtensions(
  setCustomExtension: (extension: string, language: "asm") => unknown,
) {
  // The default .s mapping is riscv, which the Highlights backend does not support.
  for (const extension of ["asm", "ASM", "s", "S", "nasm", "NASM"]) {
    setCustomExtension(extension, "asm");
  }
}
