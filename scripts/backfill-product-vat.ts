import { PrismaClient } from "@prisma/client";
import { loadDotEnv } from "../src/load-env";

loadDotEnv();

const ALLOWED = [1, 10, 20];

/** One-off: gives products without a VAT rate the default rate that used to live in the "tax" setting. */
async function main() {
  const prisma = new PrismaClient();
  try {
    const row = await prisma.siteSetting.findUnique({ where: { key: "tax" } });
    const stored = row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? (row.value as Record<string, unknown>).defaultVatRate : undefined;
    const rate = stored === undefined ? 20 : Number(stored);
    if (!ALLOWED.includes(rate)) {
      console.error(`Kayıtlı varsayılan KDV oranı (%${String(stored)}) ürün formunda seçilemiyor. Hiçbir ürün değiştirilmedi.`);
      process.exit(1);
    }
    const products = await prisma.product.findMany({ where: { vatRate: null }, select: { id: true, name: true } });
    if (!products.length) {
      console.log("KDV oranı boş ürün yok. Değişiklik yapılmadı.");
      return;
    }
    await prisma.$transaction([
      prisma.product.updateMany({ where: { id: { in: products.map((product) => product.id) }, vatRate: null }, data: { vatRate: rate } }),
      prisma.auditLog.create({
        data: {
          action: "product.vat-backfill",
          entityType: "product",
          metadata: { text: `KDV oranı boş ${products.length} ürüne %${rate} atandı.`, rate, productIds: products.map((product) => product.id) },
        },
      }),
    ]);
    console.log(`KDV oranı boş ${products.length} ürüne %${rate} atandı${row ? " (ayarlarda kayıtlı oran)" : " (ayar kaydı yok, %20)"}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("KDV oranları atanamadı.");
  process.exit(1);
});
