import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/common/password";
import { loadDotEnv } from "../src/load-env";

loadDotEnv();

function required(name: string) {
  const value = process.env[name]?.trim() ?? "";
  if (!value) {
    console.error(`${name} gerekli. Hesap oluşturulmadı.`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const email = required("OWNER_EMAIL").toLowerCase();
  const password = required("OWNER_PASSWORD");
  const name = process.env.OWNER_NAME?.trim() || "DatçaMis Owner";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("OWNER_EMAIL geçerli bir e-posta olmalı. Hesap oluşturulmadı.");
    process.exit(1);
  }
  if (password.length < 8 || password.length > 200) {
    console.error("OWNER_PASSWORD 8 ile 200 karakter arasında olmalı. Hesap oluşturulmadı.");
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const owner = await prisma.user.findFirst({
      where: { role: "OWNER", deletedAt: null },
      select: { id: true },
    });
    if (owner) {
      console.error("Aktif OWNER hesabı zaten var. Yeni hesap oluşturulmadı.");
      process.exit(1);
    }
    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      console.error("Bu e-posta zaten kayıtlı. Hesap oluşturulmadı.");
      process.exit(1);
    }
    await prisma.user.create({
      data: {
        email,
        name,
        role: "OWNER",
        status: "ACTIVE",
        passwordHash: await hashPassword(password),
      },
    });
    console.log("OWNER hesabı oluşturuldu.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("Hesap oluşturulamadı.");
  process.exit(1);
});
