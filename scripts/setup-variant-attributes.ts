/**
 * One-time, repeatable setup: links existing variants (e.g. "100 ml", "250 ml") to a shared variant attribute
 * and its values. Running it again changes nothing. Prices, stock, SKUs and order history are not touched.
 * Run:  npx tsx scripts/setup-variant-attributes.ts [--attribute=Hacim] [--dry]
 */
import { prisma } from "../src/db";
import { reportChanges, setupVariantAttributes } from "../src/catalog/attribute-setup";

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const attributeName = (arg("attribute") ?? "Hacim").trim();
const dryRun = process.argv.includes("--dry");

async function main() {
  const report = await setupVariantAttributes({ attributeName, dryRun });
  console.log(dryRun ? "DENEME (hiçbir şey kaydedilmedi)" : "Tamamlandı");
  console.log(`Yeni özellik: ${report.attributesCreated} · yeni değer: ${report.valuesCreated}`);
  console.log(`Bağlanan ürün seçeneği: ${report.optionsLinked} · bağlanan ürün değeri: ${report.valuesLinked}`);
  console.log(`Seçeneğe bağlanan ürün: ${report.productsLinked} · adı güncellenen varyant: ${report.variantsRenamed}`);
  console.log(`Toplam değişiklik: ${reportChanges(report)}`);
  if (report.unmatched.length) {
    console.log(`Eşleştirilemeyen varyantlar (${report.unmatched.length}):`);
    for (const row of report.unmatched) console.log(`- ${row.product} · ${row.name} (${row.sku}): ${row.reason}`);
  } else console.log("Eşleştirilemeyen varyant yok.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
