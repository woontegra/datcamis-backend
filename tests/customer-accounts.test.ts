import "./helpers/local-database";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildApp } from "../src/app";
import { loadEnv } from "../src/config/env";
import { prisma } from "../src/db";
import { HAVALE_SETTING_KEY } from "../src/orders/havale";

const stamp = Date.now();
const VALID_IBAN = "TR330006100519786457841326";
const PASSWORD = "Datca-Test-2026!";
const ids = { product: "", variant: "", orders: [] as string[], customers: [] as string[] };
const address = {
  fullName: "TEST Ayşe Kaya",
  phone: "05551112233",
  line1: "İskele Mah. Bademli Cad. 43/6",
  district: "Datça",
  city: "Muğla",
  postalCode: "48900",
  country: "TR",
};

const env = loadEnv();
let app: Awaited<ReturnType<typeof buildApp>>;

type Injected = Awaited<ReturnType<typeof app.inject>>;

function sessionCookie(response: Injected) {
  const cookie = response.cookies.find((row) => row.name === "dm_customer");
  return cookie ? `dm_customer=${cookie.value}` : "";
}

function email(label: string) {
  return `test-${label}-${stamp}@datcamis.local`;
}

async function register(label: string, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/account/register",
    payload: {
      firstName: "TEST",
      lastName: label,
      email: email(label),
      password: PASSWORD,
      passwordConfirm: PASSWORD,
      privacyAccepted: true,
      ...extra,
    },
  });
  if (response.statusCode === 200) ids.customers.push(response.json().data.id);
  return response;
}

async function login(mail: string, password: string) {
  return app.inject({ method: "POST", url: "/api/v1/account/login", payload: { email: mail, password } });
}

async function placeHavale(cookie: string, extra: Record<string, unknown> = {}) {
  const created = await app.inject({ method: "POST", url: "/api/v1/carts" });
  const token = created.json().data.token as string;
  await app.inject({
    method: "POST",
    url: "/api/v1/carts/current/items",
    headers: { "x-cart-token": token },
    payload: { variantId: ids.variant, quantity: 1 },
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/checkout",
    headers: { "x-cart-token": token, ...(cookie ? { cookie } : {}) },
    payload: {
      email: `guest-${stamp}@datcamis.local`,
      shippingAddress: address,
      invoice: { type: "INDIVIDUAL", sameAsShipping: true },
      paymentMethod: "havale",
      termsAccepted: true,
      ...extra,
    },
  });
  if (response.statusCode === 200) ids.orders.push(response.json().data.order.id);
  return response;
}

beforeAll(async () => {
  app = await buildApp(env);
  await app.ready();
  const product = await prisma.product.create({
    data: {
      slug: `account-test-${stamp}`,
      name: "TEST Hesap Kolonyası",
      summary: "Test",
      description: "Test",
      status: "ACTIVE",
      variants: {
        create: {
          sku: `TEST-ACCOUNT-${stamp}`,
          name: "100 ml",
          priceAmount: 12000,
          isDefault: true,
          inventory: { create: { onHand: 50 } },
        },
      },
    },
    include: { variants: true },
  });
  ids.product = product.id;
  ids.variant = product.variants[0].id;
  const value = { enabled: true, bankName: "Ziraat Bankası", accountHolder: "DatçaMis Test", iban: VALID_IBAN, note: "Açıklamaya sipariş numaranızı yazın." };
  await prisma.siteSetting.upsert({ where: { key: HAVALE_SETTING_KEY }, update: { value }, create: { key: HAVALE_SETTING_KEY, value } });
});

afterAll(async () => {
  if (ids.orders.length) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: ids.orders } } });
    await prisma.stockMovement.deleteMany({ where: { referenceId: { in: ids.orders } } });
    await prisma.order.deleteMany({ where: { id: { in: ids.orders } } });
  }
  if (ids.customers.length) {
    await prisma.cart.updateMany({ where: { customerId: { in: ids.customers } }, data: { customerId: null } });
    await prisma.customer.deleteMany({ where: { id: { in: ids.customers } } });
  }
  if (ids.product) {
    const variants = await prisma.productVariant.findMany({ where: { productId: ids.product } });
    if (variants.length) await prisma.cartItem.deleteMany({ where: { variantId: { in: variants.map((row) => row.id) } } });
    await prisma.product.delete({ where: { id: ids.product } });
  }
  await app.close();
  await prisma.$disconnect();
});

test("kayıt onay anlarını kaydeder, şifreyi hashler ve httpOnly oturum çerezi verir", async () => {
  const response = await register("kayit", { phone: "0555 111 22 33", marketingOptIn: true });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((row) => row.name === "dm_customer");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Lax");
  expect(JSON.stringify(response.json())).not.toContain(PASSWORD);
  const row = await prisma.customer.findUnique({ where: { email: email("kayit") } });
  expect(row?.privacyNoticeAcceptedAt).toBeInstanceOf(Date);
  expect(row?.marketingConsentAt).toBeInstanceOf(Date);
  expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
  const me = await app.inject({ method: "GET", url: "/api/v1/account/me", headers: { cookie: sessionCookie(response) } });
  expect(me.statusCode).toBe(200);
  expect(me.json().data.email).toBe(email("kayit"));
});

test("kampanya izni varsayılan olarak kaydedilmez, aydınlatma onayı zorunludur", async () => {
  const noPrivacy = await app.inject({
    method: "POST",
    url: "/api/v1/account/register",
    payload: { firstName: "TEST", lastName: "Onaysiz", email: email("onaysiz"), password: PASSWORD, passwordConfirm: PASSWORD, privacyAccepted: false },
  });
  expect(noPrivacy.statusCode).toBe(400);
  const short = await app.inject({
    method: "POST",
    url: "/api/v1/account/register",
    payload: { firstName: "TEST", lastName: "Kisa", email: email("kisa"), password: "1234567", passwordConfirm: "1234567", privacyAccepted: true },
  });
  expect(short.statusCode).toBe(400);
  const mismatch = await register("eslesmeyen", { passwordConfirm: `${PASSWORD}x` });
  expect(mismatch.statusCode).toBe(400);
  expect(mismatch.json().error.details).toContainEqual({ path: "passwordConfirm", message: "Şifreler eşleşmiyor." });
  expect(await prisma.customer.findUnique({ where: { email: email("eslesmeyen") } })).toBeNull();
  const plain = await register("izinsiz");
  expect(plain.statusCode).toBe(200);
  const row = await prisma.customer.findUnique({ where: { email: email("izinsiz") } });
  expect(row?.marketingConsentAt).toBeNull();
  const again = await register("izinsiz");
  expect(again.statusCode).toBe(400);
  expect(again.json().error.code).toBe("REGISTRATION_FAILED");
  expect(again.json().error.message).not.toMatch(/e-posta/i);
});

test("giriş ve hatalı giriş mesajı kayıtlı e-postayı ele vermez", async () => {
  await register("giris");
  const ok = await login(email("giris"), PASSWORD);
  expect(ok.statusCode).toBe(200);
  expect(sessionCookie(ok)).not.toBe("");
  const wrong = await login(email("giris"), "yanlis-sifre-123");
  const unknown = await login(email("yok"), "yanlis-sifre-123");
  expect(wrong.statusCode).toBe(401);
  expect(unknown.statusCode).toBe(401);
  expect(wrong.json().error.message).toBe("E-posta veya şifre hatalı.");
  expect(unknown.json().error).toEqual(wrong.json().error);
});

test("hatalı giriş sınırı hesabı kalıcı olarak geçici kilitler; kayıtsız e-posta da aynı yanıtı alır", async () => {
  await register("kilit");
  for (let i = 0; i < 5; i += 1) {
    expect((await login(email("kilit"), `yanlis-${i}-sifre`)).statusCode).toBe(401);
  }
  const locked = await login(email("kilit"), PASSWORD);
  expect(locked.statusCode).toBe(429);
  expect(sessionCookie(locked)).toBe("");
  const row = await prisma.customer.findUnique({ where: { email: email("kilit") } });
  expect(row?.loginLockedUntil && row.loginLockedUntil > new Date()).toBe(true);

  for (let i = 0; i < 5; i += 1) await login(email("kilitsiz-yok"), `yanlis-${i}-sifre`);
  const unknownLocked = await login(email("kilitsiz-yok"), PASSWORD);
  expect(unknownLocked.statusCode).toBe(429);
  expect(unknownLocked.json().error).toEqual(locked.json().error);

  await prisma.customer.update({ where: { email: email("kilit") }, data: { loginLockedUntil: new Date(Date.now() - 1000) } });
  const after = await login(email("kilit"), PASSWORD);
  expect(after.statusCode).toBe(200);
  const reset = await prisma.customer.findUnique({ where: { email: email("kilit") } });
  expect(reset?.failedLoginCount).toBe(0);
  expect(reset?.loginLockedUntil).toBeNull();
});

test("çıkış oturumu sunucuda kapatır", async () => {
  const registered = await register("cikis");
  const cookie = sessionCookie(registered);
  const out = await app.inject({ method: "POST", url: "/api/v1/account/logout", headers: { cookie } });
  expect(out.statusCode).toBe(200);
  const me = await app.inject({ method: "GET", url: "/api/v1/account/me", headers: { cookie } });
  expect(me.statusCode).toBe(401);
  const session = await app.inject({ method: "GET", url: "/api/v1/account/session", headers: { cookie } });
  expect(session.json().data).toBeNull();
});

test("müşteri oturumu hiçbir admin uç noktasına erişemez", async () => {
  const registered = await register("adminyok");
  const cookie = sessionCookie(registered);
  const token = cookie.split("=")[1];
  for (const url of ["/api/v1/admin/auth/me", "/api/v1/admin/orders", "/api/v1/admin/customers", "/api/v1/admin/dashboard", "/api/v1/admin/settings/havale"]) {
    const byCookie = await app.inject({ method: "GET", url, headers: { cookie } });
    const byBearer = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
    const asAdminCookie = await app.inject({ method: "GET", url, headers: { cookie: `dm_access=${token}` } });
    expect(byCookie.statusCode).toBe(401);
    expect(byBearer.statusCode).toBe(401);
    expect(asAdminCookie.statusCode).toBe(401);
  }
});

test("adres ekle, düzenle, varsayılan yap, sil; başka müşteri dokunamaz", async () => {
  const a = sessionCookie(await register("adres-a"));
  const b = sessionCookie(await register("adres-b"));
  const first = await app.inject({ method: "POST", url: "/api/v1/account/addresses", headers: { cookie: a }, payload: address });
  expect(first.statusCode).toBe(200);
  expect(first.json().data[0].isDefault).toBe(true);
  const second = await app.inject({
    method: "POST",
    url: "/api/v1/account/addresses",
    headers: { cookie: a },
    payload: { ...address, line1: "Kumyer Mah. 12", district: "Bodrum" },
  });
  const list = second.json().data as Array<{ id: string; isDefault: boolean; district: string }>;
  expect(list).toHaveLength(2);
  const bodrum = list.find((row) => row.district === "Bodrum")!;
  const datca = list.find((row) => row.district === "Datça")!;

  const badDistrict = await app.inject({ method: "POST", url: "/api/v1/account/addresses", headers: { cookie: a }, payload: { ...address, district: "Kadıköy" } });
  expect(badDistrict.statusCode).toBe(400);

  const edited = await app.inject({ method: "PATCH", url: `/api/v1/account/addresses/${bodrum.id}`, headers: { cookie: a }, payload: { ...address, district: "Bodrum", line1: "Yeni adres 7" } });
  expect(edited.json().data.find((row: { id: string }) => row.id === bodrum.id).line1).toBe("Yeni adres 7");

  const made = await app.inject({ method: "POST", url: `/api/v1/account/addresses/${bodrum.id}/default`, headers: { cookie: a } });
  const defaults = made.json().data.filter((row: { isDefault: boolean }) => row.isDefault);
  expect(defaults).toHaveLength(1);
  expect(defaults[0].id).toBe(bodrum.id);

  const foreignList = await app.inject({ method: "GET", url: "/api/v1/account/addresses", headers: { cookie: b } });
  expect(foreignList.json().data).toHaveLength(0);
  const foreignEdit = await app.inject({ method: "PATCH", url: `/api/v1/account/addresses/${datca.id}`, headers: { cookie: b }, payload: { ...address, line1: "Ele geçirildi" } });
  const foreignDefault = await app.inject({ method: "POST", url: `/api/v1/account/addresses/${datca.id}/default`, headers: { cookie: b } });
  const foreignDelete = await app.inject({ method: "DELETE", url: `/api/v1/account/addresses/${datca.id}`, headers: { cookie: b } });
  expect(foreignEdit.statusCode).toBe(404);
  expect(foreignDefault.statusCode).toBe(404);
  expect(foreignDelete.statusCode).toBe(404);
  const untouched = await prisma.address.findUnique({ where: { id: datca.id } });
  expect(untouched?.line1).toBe(address.line1);

  const removed = await app.inject({ method: "DELETE", url: `/api/v1/account/addresses/${bodrum.id}`, headers: { cookie: a } });
  const left = removed.json().data;
  expect(left).toHaveLength(1);
  expect(left[0].isDefault).toBe(true);

  const anonymous = await app.inject({ method: "GET", url: "/api/v1/account/addresses" });
  expect(anonymous.statusCode).toBe(401);
});

test("giriş yapmış sipariş hesaba bağlanır, adres kaydedilir; başka müşteri göremez", async () => {
  const registered = await register("siparis-a");
  const a = sessionCookie(registered);
  const b = sessionCookie(await register("siparis-b"));
  const placed = await placeHavale(a, { saveAddress: true });
  expect(placed.statusCode).toBe(200);
  const orderId = placed.json().data.order.id as string;
  const row = await prisma.order.findUnique({ where: { id: orderId } });
  expect(row?.customerId).toBe(registered.json().data.id);
  expect(row?.email).toBe(email("siparis-a"));

  const saved = await prisma.address.findMany({ where: { customerId: registered.json().data.id } });
  expect(saved).toHaveLength(1);
  expect(saved[0].isDefault).toBe(true);
  await placeHavale(a, { saveAddress: true });
  expect(await prisma.address.count({ where: { customerId: registered.json().data.id } })).toBe(1);

  await prisma.order.update({ where: { id: orderId }, data: { staffNote: "GIZLI-YONETICI-NOTU" } });
  await prisma.auditLog.create({
    data: { action: "order.status", entityType: "order", entityId: orderId, metadata: { text: "GIZLI-IPTAL-ACIKLAMASI", cancelNote: "GIZLI-IPTAL-ACIKLAMASI" } },
  });

  const list = await app.inject({ method: "GET", url: "/api/v1/account/orders", headers: { cookie: a } });
  expect(list.statusCode).toBe(200);
  expect(list.json().data.map((item: { id: string }) => item.id)).toContain(orderId);
  const first = list.json().data.find((item: { id: string }) => item.id === orderId);
  expect(first.awaitingHavale).toBe(true);
  expect(first.status.label).toBe("Ödeme bekleniyor");

  const detail = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderId}`, headers: { cookie: a } });
  expect(detail.statusCode).toBe(200);
  const data = detail.json().data;
  expect(data.havale.iban).toBe(VALID_IBAN);
  expect(data.timeline[0].label).toBe("Sipariş alındı");
  const raw = JSON.stringify(data);
  expect(raw).not.toContain("GIZLI");
  expect(raw).not.toContain("staffNote");
  expect(raw).not.toContain("accessToken");
  expect(raw).not.toContain("history");

  const foreign = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderId}`, headers: { cookie: b } });
  expect(foreign.statusCode).toBe(404);
  expect(JSON.stringify(foreign.json())).not.toContain(address.fullName);
  const foreignList = await app.inject({ method: "GET", url: "/api/v1/account/orders", headers: { cookie: b } });
  expect(foreignList.json().data).toHaveLength(0);

  await app.inject({ method: "DELETE", url: `/api/v1/account/addresses/${saved[0].id}`, headers: { cookie: a } });
  const afterDelete = await prisma.order.findUnique({ where: { id: orderId } });
  expect((afterDelete?.shippingAddress as { line1: string }).line1).toBe(address.line1);
});

test("iptal edilen siparişte iç iptal sebebi ve banka bilgisi gösterilmez", async () => {
  const a = sessionCookie(await register("iptal"));
  const placed = await placeHavale(a);
  const orderId = placed.json().data.order.id as string;
  await prisma.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
  const detail = await app.inject({ method: "GET", url: `/api/v1/account/orders/${orderId}`, headers: { cookie: a } });
  const data = detail.json().data;
  expect(data.status.label).toBe("İptal edildi");
  expect(data.havale).toBeNull();
  expect(data.timeline.at(-1).label).toBe("İptal edildi");
  expect(JSON.stringify(data)).not.toContain("Müşteri vazgeçti");
});

test("misafir sipariş aynen çalışır ve aynı e-postalı hesaba otomatik bağlanmaz", async () => {
  const registered = await register("misafir");
  const cookie = sessionCookie(registered);
  const guest = await placeHavale("", { email: email("misafir") });
  expect(guest.statusCode).toBe(200);
  expect(guest.json().data.order.accessToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  const row = await prisma.order.findUnique({ where: { id: guest.json().data.order.id } });
  expect(row?.customerId).toBeNull();
  expect(row?.email).toBe(email("misafir"));
  const list = await app.inject({ method: "GET", url: "/api/v1/account/orders", headers: { cookie } });
  expect(list.json().data).toHaveLength(0);
  const asCustomer = await app.inject({ method: "GET", url: `/api/v1/account/orders/${guest.json().data.order.id}`, headers: { cookie } });
  expect(asCustomer.statusCode).toBe(404);
});

test("şifre değiştirme mevcut şifreyi sorar ve diğer oturumları kapatır", async () => {
  const registered = await register("sifre");
  const first = sessionCookie(registered);
  const second = sessionCookie(await login(email("sifre"), PASSWORD));
  const wrong = await app.inject({ method: "POST", url: "/api/v1/account/password", headers: { cookie: first }, payload: { currentPassword: "yanlis-sifre", newPassword: "Yeni-Sifre-2026", newPasswordConfirm: "Yeni-Sifre-2026" } });
  expect(wrong.statusCode).toBe(400);
  const mismatch = await app.inject({ method: "POST", url: "/api/v1/account/password", headers: { cookie: first }, payload: { currentPassword: PASSWORD, newPassword: "Yeni-Sifre-2026", newPasswordConfirm: "Yeni-Sifre-2027" } });
  expect(mismatch.statusCode).toBe(400);
  expect(mismatch.json().error.details).toContainEqual({ path: "newPasswordConfirm", message: "Şifreler eşleşmiyor." });
  const changed = await app.inject({ method: "POST", url: "/api/v1/account/password", headers: { cookie: first }, payload: { currentPassword: PASSWORD, newPassword: "Yeni-Sifre-2026", newPasswordConfirm: "Yeni-Sifre-2026" } });
  expect(changed.statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/v1/account/me", headers: { cookie: first } })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/v1/account/me", headers: { cookie: second } })).statusCode).toBe(401);
  expect((await login(email("sifre"), PASSWORD)).statusCode).toBe(401);
  expect((await login(email("sifre"), "Yeni-Sifre-2026")).statusCode).toBe(200);
});

test("profil ad, soyad ve telefonu günceller; e-posta değişmez", async () => {
  const cookie = sessionCookie(await register("profil"));
  const updated = await app.inject({
    method: "PATCH",
    url: "/api/v1/account/profile",
    headers: { cookie },
    payload: { firstName: "TEST Yeni", lastName: "Soyad", phone: "05320000000", email: "baska@datcamis.local" },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().data.firstName).toBe("TEST Yeni");
  expect(updated.json().data.phone).toBe("05320000000");
  expect(updated.json().data.email).toBe(email("profil"));
});

test("canlı ortamda müşteri çerezi Secure olarak gönderilir", async () => {
  const prodApp = await buildApp(loadEnv({ ...process.env, NODE_ENV: "production" }));
  await prodApp.ready();
  try {
    const response = await prodApp.inject({
      method: "POST",
      url: "/api/v1/account/register",
      payload: { firstName: "TEST", lastName: "Secure", email: email("secure"), password: PASSWORD, passwordConfirm: PASSWORD, privacyAccepted: true },
    });
    expect(response.statusCode).toBe(200);
    ids.customers.push(response.json().data.id);
    const cookie = response.cookies.find((row) => row.name === "dm_customer");
    expect(cookie?.secure).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
  } finally {
    await prodApp.close();
  }
});
