import { spawn } from "node:child_process";
import { once } from "node:events";
import { stdout, stderr } from "node:process";

type Step = {
  name: string;
  command: string;
};

async function runCommand(step: Step) {
  stdout.write(`\n[verify] ▶ ${step.name}...\n`);
  const child = spawn(step.command, { shell: true, stdio: "inherit" });
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) {
    throw new Error(`[verify] ❌ Falló: ${step.name} (exit ${code})`);
  }
  stdout.write(`[verify] ✅ OK: ${step.name}\n`);
}

async function ensureGitClean() {
  stdout.write(`\n[verify] ▶ Chequeando estado de Git...\n`);
  const child = spawn("git status --porcelain", { shell: true });

  let output = "";
  child.stdout?.on("data", (d) => (output += String(d)));
  child.stderr?.pipe(stderr);

  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) {
    throw new Error("[verify] ❌ No se pudo obtener estado de Git");
  }
  if (output.trim().length > 0) {
    throw new Error(
      "[verify] ❌ Hay cambios sin commit (working tree sucia). Commit/stage antes de push."
    );
  }
  stdout.write("[verify] ✅ Git limpio\n");
}

async function main() {
  try {
    // await ensureGitClean();

    const steps: Step[] = [
      { name: "Lint (Biome)", command: "npm run lint" },
      { name: "Typecheck (tsc)", command: "npm run typecheck" },
      { name: "Tests + cobertura (Vitest)", command: "npm run test:coverage" },
      { name: "Prisma validate", command: "npx prisma validate" },
      { name: "Build", command: "npm run build" },
    ];

    for (const step of steps) {
      await runCommand(step);
    }

    stdout.write("\n[verify] 🎉 Todo OK. Listo para push.\n");
  } catch (err) {
    stderr.write(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
}

void main();
