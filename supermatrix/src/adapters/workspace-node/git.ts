import { spawn } from "node:child_process";

export type GitIdentity = {
  name: string;
  email: string;
};

export async function runGit(
  cwd: string,
  args: string[],
  identity?: GitIdentity
): Promise<void> {
  const fullArgs = [
    ...(identity
      ? ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`]
      : []),
    ...args,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", fullArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}
