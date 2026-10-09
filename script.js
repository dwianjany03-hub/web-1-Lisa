// ===== DATA STORAGE (localStorage) =====
const DB = {
    get(key, def = []) {
        return JSON.parse(localStorage.getItem(key)) || def;
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (err) {
            showToast('Penyimpanan penuh! Foto produk terlalu banyak/besar.', 'error');
            return false;
        }
    }
};

// ===== IMAGE STORE (IndexedDB) =====
// Foto produk disimpan di IndexedDB, localStorage hanya menyimpan referensi "idb:<key>"
const ImageStore = (() => {
    const DB_NAME = 'anjani_images';
    const STORE = 'images';
    const cache = new Map();
    let dbP = null;

    function open() {
        if (dbP) return dbP;
        dbP = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) { reject(new Error('IndexedDB tidak tersedia')); return; }
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch(err => {
            console.log('IndexedDB error:', err);
            return null;
        });
        return dbP;
    }

    async function set(key, value) {
        cache.set(key, value);
        const db = await open();
        if (!db) return false;
        try {
            await new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).put(value, key);
                t.oncomplete = () => resolve(true);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            });
            return true;
        } catch (err) {
            console.log('IndexedDB write error:', err);
            return false;
        }
    }

    async function remove(key) {
        cache.delete(key);
        const db = await open();
        if (!db) return;
        try {
            await new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readwrite');
                t.objectStore(STORE).delete(key);
                t.oncomplete = () => resolve(true);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            });
        } catch (err) {
            console.log('IndexedDB delete error:', err);
        }
    }

    async function loadAll() {
        const db = await open();
        if (!db) return;
        try {
            await new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readonly');
                const cur = t.objectStore(STORE).openCursor();
                cur.onsuccess = () => {
                    const c = cur.result;
                    if (c) {
                        cache.set(String(c.key), c.value);
                        c.continue();
                    }
                };
                t.oncomplete = () => resolve(true);
                t.onerror = () => reject(t.error);
            });
            console.log('[ImageStore] Loaded', cache.size, 'images');
        } catch (err) {
            console.log('IndexedDB read error:', err);
            showToast('Gagal memuat foto dari penyimpanan', 'error');
        }
    }

    async function allKeys() {
        const db = await open();
        if (!db) return [];
        try {
            return await new Promise((resolve, reject) => {
                const t = db.transaction(STORE, 'readonly');
                const r = t.objectStore(STORE).getAllKeys();
                t.oncomplete = () => resolve(r.result || []);
                t.onerror = () => reject(t.error);
            });
        } catch (err) {
            return [];
        }
    }

    return {
        init: loadAll,
        get: key => (key && cache.has(key)) ? cache.get(key) : '',
        set,
        remove,
        allKeys,
        makeKey: () => 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        gc: async (used) => {
            const keys = await allKeys();
            for (const key of keys) {
                if (!used.has(String(key))) await remove(String(key));
            }
        }
    };
})();

function resolveImage(ref) {
    if (!ref) return '';
    if (typeof ref !== 'string') return '';
    if (ref.indexOf('idb:') === 0) {
        const key = ref.slice(4);
        let val = ImageStore.get(key);
        if (val) return val;
        // fallback: coba baca langsung dari IndexedDB (kalau cache kosong)
        (async () => {
            try {
                const db = await ImageStore.open?.();
                if (db) {
                    const v = await new Promise(res => {
                        const t = db.transaction('images', 'readonly');
                        const req = t.objectStore('images').get(key);
                        req.onsuccess = () => res(req.result || '');
                    });
                    if (v) ImageStore.get = k => k === key ? v : ImageStore.get(k);
                }
            } catch (_) {}
        })();
        return '';
    }
    return ref;
}

function releaseUnusedImages() {
    const used = new Set();
    products.forEach(p => {
        if (p.image && typeof p.image === 'string' && p.image.indexOf('idb:') === 0) {
            used.add(p.image.slice(4));
        }
    });
    ImageStore.gc(used);
}

// Pindahkan foto lama (base64 di localStorage) ke IndexedDB
async function migrateInlineImages() {
    let changed = false;
    for (const p of products) {
        if (p.image && typeof p.image === 'string' && p.image.indexOf('data:') === 0) {
            const key = ImageStore.makeKey();
            if (await ImageStore.set(key, p.image)) {
                p.image = 'idb:' + key;
                changed = true;
            }
        }
    }
    if (changed) DB.set('anjani_products', products);
}

// ===== STATE =====
let products = DB.get('anjani_products');
let stockHistory = DB.get('anjani_stock_history');
let transactions = DB.get('anjani_transactions');
let customers = DB.get('anjani_customers');
let customerPayments = DB.get('anjani_customer_payments');
let cart = [];
let currentReportPeriod = 'harian';
let pendingImage = '';
let editingImageRef = '';

const IMG_MAX_SIZE = 480;
const IMG_QUALITY = 0.75;

// Seed pelanggan contoh saat pertama kali dibuka
if (localStorage.getItem('anjani_customers') === null) {
    customers = [
        { id: 1001, name: 'Bu Sari', phone: '081234567890' },
        { id: 1002, name: 'Pak Budi', phone: '089876543210' }
    ];
    DB.set('anjani_customers', customers);
}

// Seed data jika kosong (contoh produk sembako)
if (products.length === 0) {
    products = [
        { id: 1, name: 'Beras Premium 5kg', category: 'Sembako', buyPrice: 60000, sellPrice: 70000, stock: 15, minStock: 5 },
        { id: 2, name: 'Minyak Goreng 2L', category: 'Sembako', buyPrice: 28000, sellPrice: 33000, stock: 20, minStock: 5 },
        { id: 3, name: 'Gula Pasir 1kg', category: 'Sembako', buyPrice: 13000, sellPrice: 15000, stock: 25, minStock: 5 },
        { id: 4, name: 'Indomie Goreng', category: 'Mie Instan', buyPrice: 2800, sellPrice: 3500, stock: 3, minStock: 10 },
        { id: 5, name: 'Teh Botol Sosro', category: 'Minuman', buyPrice: 3000, sellPrice: 4000, stock: 30, minStock: 10 },
        { id: 6, name: 'Sabun Mandi Lifebuoy', category: 'Kebutuhan Rumah', buyPrice: 3500, sellPrice: 5000, stock: 18, minStock: 5 },
        { id: 7, name: 'Chitato Sapi Panggang', category: 'Makanan Ringan', buyPrice: 8000, sellPrice: 10000, stock: 12, minStock: 5 },
        { id: 8, name: 'Kopi Kapal Api', category: 'Minuman', buyPrice: 1500, sellPrice: 2000, stock: 50, minStock: 10 }
    ];
    DB.set('anjani_products', products);
}

// ===== SANITASI DATA =====
// Data bisa rusak: file backup diedit manual, penyimpanan terpotong, atau versi lama.
function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function cleanStr(v, fallback = '') {
    if (v == null) return fallback;
    return typeof v === 'string' ? v : String(v);
}

function cleanDate(v) {
    const d = new Date(v);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function asList(v) {
    return Array.isArray(v) ? v : [];
}

function asObject(src) {
    return (src && typeof src === 'object' && !Array.isArray(src)) ? src : {};
}

function sanitizeCollections() {
    const pid = new Set();
    products = asList(products).map(asObject)
        .map((src, i) => {
            let id = Math.round(num(src.id, 0));
            if (!id || pid.has(id)) id = Date.now() + i;
            pid.add(id);
            return {
                id,
                name: cleanStr(src.name).trim(),
                category: cleanStr(src.category).trim() || 'Lainnya',
                buyPrice: Math.max(0, Math.round(num(src.buyPrice))),
                sellPrice: Math.max(0, Math.round(num(src.sellPrice))),
                stock: Math.max(0, Math.round(num(src.stock))),
                minStock: Math.max(0, Math.round(num(src.minStock, 5))),
                image: typeof src.image === 'string' ? src.image : ''
            };
        })
        .filter(p => p.name !== '');

    transactions = asList(transactions).map(asObject).map((src, i) => {
        const items = asList(src.items).map(asObject).map(it => ({
            productId: Math.round(num(it.productId, 0)),
            name: cleanStr(it.name).trim(),
            price: Math.max(0, Math.round(num(it.price))),
            buyPrice: Math.max(0, Math.round(num(it.buyPrice))),
            qty: Math.max(0, Math.round(num(it.qty, 0))),
            category: cleanStr(it.category),
            image: typeof it.image === 'string' ? it.image : ''
        })).filter(it => it.name !== '' && it.qty > 0);
        const subtotal = Math.max(0, Math.round(num(src.subtotal)));
        const total = Math.max(0, Math.round(num(src.total)));
        return {
            id: Math.round(num(src.id, Date.now() + i)),
            items,
            subtotal,
            discount: Math.max(0, Math.min(Math.round(num(src.discount)), subtotal || total)),
            total,
            paid: Math.max(0, Math.round(num(src.paid))),
            change: Math.max(0, Math.round(num(src.change))),
            debt: Math.max(0, Math.round(num(src.debt))),
            customerId: src.customerId ? Math.round(num(src.customerId, 0)) : null,
            method: src.method === 'utang' ? 'utang' : 'tunai',
            date: cleanDate(src.date)
        };
    });

    const cid = new Set();
    customers = asList(customers).map(asObject).map((src, i) => {
        let id = Math.round(num(src.id, 0));
        if (!id || cid.has(id)) id = Date.now() + i;
        cid.add(id);
        return { id, name: cleanStr(src.name).trim(), phone: cleanStr(src.phone).trim() };
    }).filter(c => c.name !== '');

    stockHistory = asList(stockHistory).map(asObject).map((src, i) => ({
        id: Math.round(num(src.id, Date.now() + i)),
        productId: Math.round(num(src.productId, 0)),
        productName: cleanStr(src.productName),
        type: src.type === 'keluar' ? 'keluar' : 'masuk',
        amount: Math.max(0, Math.round(num(src.amount))),
        note: cleanStr(src.note),
        date: cleanDate(src.date)
    })).filter(h => h.amount > 0);

    customerPayments = asList(customerPayments).map(asObject).map((src, i) => ({
        id: Math.round(num(src.id, Date.now() + i)),
        customerId: Math.round(num(src.customerId, 0)),
        amount: Math.max(0, Math.round(num(src.amount))),
        note: cleanStr(src.note),
        date: cleanDate(src.date)
    })).filter(p => p.amount > 0 && p.customerId > 0);
}

function collectionByKey(key) {
    if (key === 'anjani_products') return products;
    if (key === 'anjani_stock_history') return stockHistory;
    if (key === 'anjani_transactions') return transactions;
    if (key === 'anjani_customers') return customers;
    if (key === 'anjani_customer_payments') return customerPayments;
    return [];
}

// ===== NAVIGATION =====
document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('page-' + tab.dataset.page).classList.add('active');
        renderCurrentPage(tab.dataset.page);
    });
});

function renderCurrentPage(page) {
    if (page === 'dashboard') renderDashboard();
    else if (page === 'produk') renderProducts();
    else if (page === 'stok') renderStockHistory();
    else if (page === 'penjualan') renderSalesProducts();
    else if (page === 'laporan') renderReport();
    else if (page === 'pelanggan') renderCustomers();
    else if (page === 'setelan') renderSettings();
}

function refreshActivePage() {
    const active = document.querySelector('.nav-tab.active');
    renderCurrentPage(active ? active.dataset.page : 'dashboard');
}

// ===== UTILS =====
function formatRupiah(num) {
    return 'Rp ' + (num || 0).toLocaleString('id-ID');
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function esc(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function getCustomerName(id) {
    if (!id) return 'Pelanggan Umum';
    const c = customers.find(x => x.id === id);
    return c ? c.name : 'Pelanggan Umum';
}

function getCustomerDebt(custId) {
    const owed = transactions
        .filter(t => t.customerId === custId && t.method === 'utang')
        .reduce((sum, t) => sum + (t.total - (t.paid || 0)), 0);
    const paid = customerPayments
        .filter(p => p.customerId === custId)
        .reduce((sum, p) => sum + p.amount, 0);
    return Math.max(0, owed - paid);
}

function getTotalDebt() {
    return customers.reduce((sum, c) => sum + getCustomerDebt(c.id), 0);
}

function getCartTotals() {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
    const input = parseInt(document.getElementById('saleDiscount').value) || 0;
    const type = document.getElementById('saleDiscountType').value;
    let discount = type === 'percent'
        ? Math.round(subtotal * Math.min(input, 100) / 100)
        : input;
    discount = Math.max(0, Math.min(discount, subtotal));
    const paid = parseInt(document.getElementById('salePaid').value) || 0;
    return { subtotal, discount, total: subtotal - discount, paid };
}

function renderSaleCustomerOptions() {
    const select = document.getElementById('saleCustomer');
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Pelanggan Umum</option>' +
        customers.map(c => {
            const debt = getCustomerDebt(c.id);
            const suffix = debt > 0 ? ` — utang ${formatRupiah(debt)}` : '';
            return `<option value="${parseInt(c.id) || 0}">${esc(c.name)}${suffix}</option>`;
        }).join('');
    if (current) select.value = current;
}

function showToast(msg, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast ' + type;
    setTimeout(() => toast.classList.add('hidden'), 2500);
}

function getCategoryEmoji(cat) {
    const map = {
        'Sembako': '🌾',
        'Minuman': '🥤',
        'Makanan Ringan': '🍿',
        'Mie Instan': '🍜',
        'Kebutuhan Rumah': '🧴',
        'Lainnya': '📦'
    };
    return map[cat] || '📦';
}

function imgFallback(el) {
    el.style.display = 'none';
}

function safeAttr(value) {
    return String(value).replace(/"/g, '&quot;');
}

function productPhotoHtml(item, extraClass = '') {
    const emoji = getCategoryEmoji(item.category);
    const src = safeAttr(resolveImage(item.image));
    const photo = src
        ? `<img src="${src}" alt="" loading="lazy" onerror="imgFallback(this)">`
        : '';
    return `<div class="product-photo ${extraClass}">${photo}<span class="thumb-emoji">${emoji}</span></div>`;
}

function compressImage(file, maxSize = IMG_MAX_SIZE, quality = IMG_QUALITY) {
    return new Promise((resolve, reject) => {
        if (!file || !file.type.startsWith('image/')) {
            reject(new Error('File harus berupa gambar'));
            return;
        }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Gagal membaca file'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('Gambar tidak bisa diproses'));
            img.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function renderPhotoPreview() {
    const wrap = document.getElementById('photoPreview');
    const photo = pendingImage
        ? `<img src="${safeAttr(pendingImage)}" alt="Preview foto produk" onerror="imgFallback(this)">`
        : '';
    wrap.innerHTML = `${photo}<span class="thumb-emoji">📷</span>`;
}

async function handlePhotoPick(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
        pendingImage = await compressImage(file);
        document.getElementById('productImageUrl').value = '';
        renderPhotoPreview();
        showToast('Foto siap disimpan');
    } catch (err) {
        showToast(err.message || 'Gagal memproses foto', 'error');
    }
}

function usePhotoUrl() {
    const url = document.getElementById('productImageUrl').value.trim();
    if (url) {
        pendingImage = url;
        renderPhotoPreview();
    }
}

function clearPendingImage() {
    pendingImage = '';
    document.getElementById('productImageUrl').value = '';
    renderPhotoPreview();
}

// ===== DASHBOARD =====
function renderDashboard() {
    const today = new Date().toDateString();
    const todayTransactions = transactions.filter(t => new Date(t.date).toDateString() === today);
    const totalStock = products.reduce((sum, p) => sum + p.stock, 0);
    const todayRevenue = todayTransactions.reduce((sum, t) => sum + t.total, 0);

    document.getElementById('statProduk').textContent = products.length;
    document.getElementById('statStok').textContent = totalStock;
    document.getElementById('statPenjualan').textContent = todayTransactions.length;
    document.getElementById('statPendapatan').textContent = formatRupiah(todayRevenue);

    // Low stock
    const lowStock = products.filter(p => p.stock <= p.minStock);
    const lowStockList = document.getElementById('lowStockList');
    if (lowStock.length === 0) {
        lowStockList.innerHTML = '<p class="empty-state">Semua stok aman 👍</p>';
    } else {
        lowStockList.innerHTML = lowStock.map(p => `
            <div class="low-stock-item">
                ${productPhotoHtml(p, 'product-photo-xs')}
                <div>
                    <div class="name">${esc(p.name)}</div>
                    <div style="font-size:11px;color:var(--text-light)">Stok minimum: ${parseInt(p.minStock) || 0}</div>
                </div>
                <div class="stock">⚠️ Sisa: ${p.stock}</div>
            </div>
        `).join('');
    }
}

// ===== PRODUCTS =====
function renderProducts() {
    const search = document.getElementById('searchProduct').value.toLowerCase();
    const filtered = products.filter(p => {
        const name = String(p.name || '').toLowerCase();
        const cat = String(p.category || '').toLowerCase();
        return name.includes(search) || cat.includes(search);
    });
    
    const list = document.getElementById('productList');
    if (filtered.length === 0) {
        list.innerHTML = '<p class="empty-state">Tidak ada produk ditemukan</p>';
        return;
    }
    
    list.innerHTML = filtered.map(p => {
        let stockClass = 'stock-ok';
        let stockLabel = `Stok: ${p.stock}`;
        if (p.stock === 0) {
            stockClass = 'stock-out';
            stockLabel = 'Habis!';
        } else if (p.stock <= p.minStock) {
            stockClass = 'stock-low';
            stockLabel = `⚠️ Hampir habis: ${p.stock}`;
        }
        
        return `
            <div class="product-card">
                ${productPhotoHtml(p)}
                <h4>${esc(p.name)}</h4>
                <span class="product-category">${esc(p.category)}</span>
                <div class="product-info">
                    <span class="label">Harga Beli:</span>
                    <span class="value">${formatRupiah(p.buyPrice)}</span>
                </div>
                <div class="product-info">
                    <span class="label">Harga Jual:</span>
                    <span class="value">${formatRupiah(p.sellPrice)}</span>
                </div>
                <span class="product-stock ${stockClass}">${stockLabel}</span>
                <div class="product-actions">
                    <button class="btn btn-primary btn-sm" onclick="editProduct(${parseInt(p.id) || 0})">✏️ Edit</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProduct(${parseInt(p.id) || 0})">🗑️ Hapus</button>
                </div>
            </div>
        `;
    }).join('');
}

document.getElementById('searchProduct').addEventListener('input', renderProducts);

function openProductModal(product = null) {
    document.getElementById('productModal').classList.remove('hidden');
    document.getElementById('productForm').reset();
    document.getElementById('productId').value = '';
    document.getElementById('productModalTitle').textContent = 'Tambah Produk';

    editingImageRef = (product && product.image && product.image.indexOf('idb:') === 0) ? product.image : '';
    pendingImage = product ? resolveImage(product.image) : '';
    document.getElementById('productImageUrl').value =
        (pendingImage && !pendingImage.startsWith('data:')) ? pendingImage : '';
    renderPhotoPreview();

    if (product) {
        document.getElementById('productModalTitle').textContent = 'Edit Produk';
        document.getElementById('productId').value = product.id;
        document.getElementById('productName').value = product.name;
        document.getElementById('productCategory').value = product.category;
        document.getElementById('productBuyPrice').value = product.buyPrice;
        document.getElementById('productSellPrice').value = product.sellPrice;
        document.getElementById('productStock').value = product.stock;
        document.getElementById('productMinStock').value = product.minStock;
    }
}

function closeProductModal() {
    document.getElementById('productModal').classList.add('hidden');
}

async function commitPendingImage() {
    if (!pendingImage) return '';
    if (editingImageRef && pendingImage === ImageStore.get(editingImageRef.slice(4))) {
        return editingImageRef;
    }
    if (pendingImage.indexOf('data:') !== 0) return pendingImage;

    const key = ImageStore.makeKey();
    const ok = await ImageStore.set(key, pendingImage);
    return ok ? 'idb:' + key : pendingImage;
}

async function saveProduct(e) {
    e.preventDefault();
    const id = document.getElementById('productId').value;
    const name = document.getElementById('productName').value.trim();
    const category = document.getElementById('productCategory').value.trim();
    const buyPrice = parseInt(document.getElementById('productBuyPrice').value);
    const sellPrice = parseInt(document.getElementById('productSellPrice').value);
    const stock = parseInt(document.getElementById('productStock').value);
    const minStockRaw = parseInt(document.getElementById('productMinStock').value);

    if (!name) {
        showToast('Nama produk wajib diisi', 'error');
        return false;
    }
    if (!category) {
        showToast('Kategori wajib dipilih', 'error');
        return false;
    }
    if (!Number.isFinite(buyPrice) || buyPrice < 0 || !Number.isFinite(sellPrice) || sellPrice < 0) {
        showToast('Harga beli/jual tidak valid', 'error');
        return false;
    }
    if (!Number.isFinite(stock) || stock < 0) {
        showToast('Stok tidak valid', 'error');
        return false;
    }

    const data = {
        name,
        category,
        buyPrice,
        sellPrice,
        stock,
        minStock: Number.isFinite(minStockRaw) && minStockRaw >= 0 ? minStockRaw : 5,
        image: await commitPendingImage()
    };

    if (id) {
        const idx = products.findIndex(p => String(p.id) === String(id));
        if (idx === -1) {
            showToast('Produk tidak ditemukan', 'error');
            return false;
        }
        products[idx] = { ...products[idx], ...data };
        showToast('Produk berhasil diupdate');
    } else {
        data.id = Date.now();
        products.push(data);
        showToast('Produk berhasil ditambahkan');
    }

    DB.set('anjani_products', products);
    releaseUnusedImages();
    closeProductModal();
    renderProducts();
    return true;
}

function editProduct(id) {
    const product = products.find(p => p.id === id);
    if (product) openProductModal(product);
}

function deleteProduct(id) {
    if (!confirm('Yakin ingin menghapus produk ini?')) return;
    products = products.filter(p => p.id !== id);
    const before = cart.length;
    cart = cart.filter(c => c.productId !== id);
    if (cart.length !== before) renderCart();
    DB.set('anjani_products', products);
    releaseUnusedImages();
    renderProducts();
    showToast('Produk dihapus', 'success');
}

// ===== STOCK MANAGEMENT =====
function openStockModal(type) {
    document.getElementById('stockModal').classList.remove('hidden');
    document.getElementById('stockType').value = type;
    document.getElementById('stockModalTitle').textContent = type === 'masuk' ? '📥 Stok Masuk' : '📤 Stok Keluar';
    
    const select = document.getElementById('stockProduct');
    select.innerHTML = '<option value="">Pilih Produk</option>' + 
        products.map(p => `<option value="${parseInt(p.id) || 0}">${esc(p.name)} (Stok: ${parseInt(p.stock) || 0})</option>`).join('');
    
    document.getElementById('stockAmount').value = '';
    document.getElementById('stockNote').value = '';
}

function closeStockModal() {
    document.getElementById('stockModal').classList.add('hidden');
}

function saveStockChange(e) {
    e.preventDefault();
    const type = document.getElementById('stockType').value;
    const productId = parseInt(document.getElementById('stockProduct').value);
    const amount = parseInt(document.getElementById('stockAmount').value);
    const note = document.getElementById('stockNote').value;

    if (type !== 'masuk' && type !== 'keluar') {
        showToast('Jenis perubahan stok tidak valid', 'error');
        return false;
    }
    const product = products.find(p => p.id === productId);
    if (!product) {
        showToast('Pilih produk dulu', 'error');
        return false;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast('Jumlah harus lebih dari 0', 'error');
        return false;
    }
    if (type === 'keluar' && amount > product.stock) {
        showToast('Stok tidak mencukupi!', 'error');
        return false;
    }

    if (type === 'masuk') {
        product.stock += amount;
    } else {
        product.stock -= amount;
    }
    
    stockHistory.unshift({
        id: Date.now(),
        productId: product.id,
        productName: product.name,
        type,
        amount,
        note,
        date: new Date().toISOString()
    });
    
    DB.set('anjani_products', products);
    DB.set('anjani_stock_history', stockHistory);
    closeStockModal();
    renderStockHistory();
    showToast(`Stok ${type} berhasil dicatat`);
    return true;
}

function renderStockHistory() {
    const list = document.getElementById('stockHistory');
    if (stockHistory.length === 0) {
        list.innerHTML = '<p class="empty-state">Belum ada riwayat perubahan stok</p>';
        return;
    }
    
    list.innerHTML = stockHistory.slice(0, 50).map(h => {
        const prod = products.find(x => x.id === h.productId) || { name: h.productName };
        const type = h.type === 'masuk' ? 'masuk' : 'keluar';
        const amount = parseInt(h.amount) || 0;
        return `
        <div class="stock-history-item ${type}">
            ${productPhotoHtml(prod, 'product-photo-xs')}
            <div class="info">
                <div class="name">${esc(h.productName)}</div>
                <div class="meta">${formatDate(h.date)}${h.note ? ' • ' + esc(h.note) : ''}</div>
            </div>
            <div class="amount ${type === 'masuk' ? 'amount-in' : 'amount-out'}">
                ${type === 'masuk' ? '+' : '-'}${amount}
            </div>
        </div>
    `;
    }).join('');
}

// ===== SALES =====
function renderSalesProducts() {
    renderSaleCustomerOptions();
    const search = document.getElementById('searchSales').value.toLowerCase();
    const filtered = products.filter(p => 
        p.name.toLowerCase().includes(search) && p.stock > 0
    );
    
    const list = document.getElementById('salesProductList');
    if (filtered.length === 0) {
        list.innerHTML = '<p class="empty-state">Tidak ada produk tersedia</p>';
        return;
    }
    
    list.innerHTML = filtered.map(p => `
        <div class="sales-product-item" onclick="addToCart(${parseInt(p.id) || 0})">
            ${productPhotoHtml(p, 'product-photo-sm')}
            <div class="name">${esc(p.name)}</div>
            <div class="price">${formatRupiah(p.sellPrice)}</div>
            <div class="stock-badge">Stok: ${parseInt(p.stock) || 0}</div>
        </div>
    `).join('');
}

document.getElementById('searchSales').addEventListener('input', renderSalesProducts);

['saleDiscount', 'saleDiscountType', 'salePaid'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', renderCart);
    el.addEventListener('change', renderCart);
});

function addToCart(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;
    if (!(Number(product.stock) > 0)) return;

    const existing = cart.find(c => c.productId === productId);
    if (existing) {
        if (existing.qty >= product.stock) {
            showToast('Stok tidak mencukupi!', 'error');
            return;
        }
        existing.qty++;
    } else {
        cart.push({
            productId: product.id,
            name: product.name,
            price: product.sellPrice,
            buyPrice: product.buyPrice,
            image: product.image || '',
            category: product.category,
            qty: 1
        });
    }
    renderCart();
}

function updateCartQty(productId, delta) {
    const item = cart.find(c => c.productId === productId);
    if (!item) return;

    const product = products.find(p => p.id === productId);
    if (!product) {
        cart = cart.filter(c => c.productId !== productId);
        renderCart();
        showToast('Produk sudah tidak ada, item dikeluarkan dari keranjang', 'error');
        return;
    }

    const newQty = item.qty + delta;

    if (newQty <= 0) {
        cart = cart.filter(c => c.productId !== productId);
    } else if (newQty > product.stock) {
        showToast('Stok tidak mencukupi!', 'error');
        return;
    } else {
        item.qty = newQty;
    }
    renderCart();
}

function renderCart() {
    const list = document.getElementById('cartList');
    const totals = getCartTotals();

    if (cart.length === 0) {
        list.innerHTML = '<p class="empty-state">Keranjang kosong</p>';
    } else {
        list.innerHTML = cart.map(item => `
            <div class="cart-item">
                ${productPhotoHtml(item, 'product-photo-xs')}
                <div class="cart-item-info">
                    <div class="name">${esc(item.name)}</div>
                    <div class="price">${formatRupiah(item.price)} × ${item.qty}</div>
                </div>
                <div class="cart-item-qty">
                    <button class="qty-btn" onclick="updateCartQty(${item.productId}, -1)">−</button>
                    <span class="qty-value">${item.qty}</span>
                    <button class="qty-btn" onclick="updateCartQty(${item.productId}, 1)">+</button>
                </div>
                <div class="cart-item-total">${formatRupiah(item.price * item.qty)}</div>
            </div>
        `).join('');
    }

    document.getElementById('cartSubtotal').textContent = formatRupiah(totals.subtotal);
    document.getElementById('cartDiscount').textContent = '- ' + formatRupiah(totals.discount);
    document.getElementById('cartTotal').textContent = formatRupiah(totals.total);
    document.getElementById('discountRow').classList.toggle('hidden', totals.discount <= 0);

    const change = totals.paid - totals.total;
    const changeRow = document.getElementById('changeRow');
    if (totals.total > 0 && totals.paid >= totals.total) {
        changeRow.classList.remove('hidden');
        document.getElementById('cartChange').textContent = formatRupiah(change);
    } else {
        changeRow.classList.add('hidden');
    }

    const owed = totals.total - totals.paid;
    const debtRow = document.getElementById('debtRow');
    if (totals.total > 0 && totals.paid > 0 && owed > 0) {
        debtRow.classList.remove('hidden');
        document.getElementById('cartDebt').textContent = formatRupiah(owed);
    } else {
        debtRow.classList.add('hidden');
    }
}

function resetSaleForm() {
    cart = [];
    document.getElementById('saleDiscount').value = 0;
    document.getElementById('saleDiscountType').value = 'rp';
    document.getElementById('salePaid').value = '';
    document.getElementById('saleCustomer').value = '';
    renderCart();
}

function clearCart() {
    if (cart.length === 0) return;
    if (!confirm('Batalkan transaksi?')) return;
    resetSaleForm();
}

function processSale(method = 'tunai') {
    if (cart.length === 0) {
        showToast('Keranjang kosong!', 'error');
        return;
    }

    const totals = getCartTotals();
    const customerId = parseInt(document.getElementById('saleCustomer').value) || null;
    let paid = totals.paid;
    let change = 0;

    if (method === 'tunai') {
        if (paid < totals.total) {
            showToast('Uang diterima kurang dari total!', 'error');
            document.getElementById('salePaid').focus();
            return;
        }
        change = paid - totals.total;
        paid = totals.total;
    } else {
        if (!customerId) {
            showToast('Pilih pelanggan dulu untuk transaksi utang', 'error');
            return;
        }
        paid = Math.max(0, Math.min(paid, totals.total));
        if (paid >= totals.total) {
            showToast('Sudah lunas, pakai tombol Bayar Tunai', 'error');
            return;
        }
    }

    const invalidItem = cart.find(item => {
        const p = products.find(x => x.id === item.productId);
        return !p || !(Number(item.qty) > 0) || !(Number(item.price) >= 0);
    });
    if (invalidItem) {
        showToast(`Item "${invalidItem.name || 'tidak dikenal'}" tidak valid, hapus dari keranjang`, 'error');
        return;
    }

    const oversold = cart.find(item => {
        const p = products.find(x => x.id === item.productId);
        return p && item.qty > p.stock;
    });
    if (oversold) {
        showToast(`Stok ${oversold.name} tidak mencukupi!`, 'error');
        return;
    }

    cart.forEach(item => {
        const product = products.find(p => p.id === item.productId);
        if (product) product.stock -= item.qty;
    });

    transactions.unshift({
        id: Date.now(),
        items: [...cart],
        subtotal: totals.subtotal,
        discount: totals.discount,
        total: totals.total,
        paid,
        change,
        debt: totals.total - paid,
        customerId,
        method,
        date: new Date().toISOString()
    });

    DB.set('anjani_products', products);
    DB.set('anjani_transactions', transactions);

    if (method === 'utang') {
        showToast(`Utang ${getCustomerName(customerId)} menjadi ${formatRupiah(getCustomerDebt(customerId))} 💳`);
    } else {
        showToast(`Transaksi ${formatRupiah(totals.total)} berhasil! 💰`);
    }

    resetSaleForm();
    renderSalesProducts();
}

// ===== REPORTS =====
document.querySelectorAll('.report-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.report-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentReportPeriod = tab.dataset.period;
        renderReport();
    });
});

function filterByPeriod(list, period) {
    const now = new Date();
    if (period === 'semua') return list.slice();
    if (period === 'mingguan') {
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        return list.filter(t => new Date(t.date) >= weekAgo);
    }
    if (period === 'bulanan') {
        return list.filter(t => {
            const d = new Date(t.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });
    }
    return list.filter(t => new Date(t.date).toDateString() === now.toDateString());
}

function itemCost(item) {
    let buy = item.buyPrice;
    if (buy == null || isNaN(buy)) {
        const p = products.find(x => x.id === item.productId) || products.find(x => x.name === item.name);
        buy = p ? p.buyPrice : 0;
    }
    return (Number(buy) || 0) * (Number(item.qty) || 0);
}

function transactionCost(t) {
    return (t.items || []).reduce((sum, item) => sum + itemCost(item), 0);
}

function calcProfitReport(rows) {
    const revenue = rows.reduce((sum, t) => sum + (Number(t.total) || 0), 0);
    const cost = rows.reduce((sum, t) => sum + transactionCost(t), 0);
    const net = revenue - cost;
    const qty = rows.reduce((sum, t) =>
        sum + (t.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0), 0);
    return {
        revenue,
        cost,
        net,
        margin: revenue > 0 ? (net / revenue) * 100 : 0,
        count: rows.length,
        avg: rows.length ? revenue / rows.length : 0,
        qty
    };
}

const REPORT_PERIOD_LABEL = {
    harian: 'Harian',
    mingguan: 'Mingguan',
    bulanan: 'Bulanan',
    semua: 'Semua'
};

function renderProfitReport(rows) {
    const r = calcProfitReport(rows);
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };
    set('profitPeriod', REPORT_PERIOD_LABEL[currentReportPeriod] || 'Harian');
    set('profitRevenue', formatRupiah(r.revenue));
    set('profitCost', formatRupiah(r.cost));
    set('profitNet', (r.net < 0 ? '- ' : '') + formatRupiah(Math.abs(r.net)));
    set('profitMargin', (r.margin >= 0 ? '' : '-') + Math.abs(r.margin).toFixed(1) + '%');
    set('profitAvg', formatRupiah(Math.round(r.avg)));
    set('profitQty', r.qty + ' barang');
    const row = document.getElementById('profitTotalRow');
    if (row) row.classList.toggle('is-loss', r.net < 0);
}

function renderReport() {
    const filtered = filterByPeriod(transactions, currentReportPeriod);

    const totalRevenue = filtered.reduce((sum, t) => sum + t.total, 0);
    document.getElementById('reportRevenue').textContent = formatRupiah(totalRevenue);
    document.getElementById('reportTransactions').textContent = filtered.length;
    document.getElementById('reportDebt').textContent = formatRupiah(getTotalDebt());
    renderProfitReport(filtered);
    
    // Best sellers
    const productSales = {};
    filtered.forEach(t => {
        t.items.forEach(item => {
            if (!productSales[item.productId]) {
                productSales[item.productId] = { name: item.name, qty: 0, revenue: 0 };
            }
            productSales[item.productId].qty += item.qty;
            productSales[item.productId].revenue += item.price * item.qty;
        });
    });
    
    const bestSellers = Object.values(productSales).sort((a, b) => b.qty - a.qty).slice(0, 5);
    const bestList = document.getElementById('bestSellers');
    if (bestSellers.length === 0) {
        bestList.innerHTML = '<p class="empty-state">Belum ada penjualan</p>';
    } else {
        bestList.innerHTML = bestSellers.map((p, i) => {
            const prod = products.find(x => x.name === p.name) || { name: p.name };
            return `
            <div class="best-seller-item">
                <div class="rank">${i + 1}</div>
                ${productPhotoHtml(prod, 'product-photo-xs')}
                <div class="info">
                    <div class="name">${esc(p.name)}</div>
                    <div class="sold">Terjual: ${p.qty} • ${formatRupiah(p.revenue)}</div>
                </div>
            </div>
        `;
        }).join('');
    }
    
    // Transaction history
    const txList = document.getElementById('transactionHistory');
    if (filtered.length === 0) {
        txList.innerHTML = '<p class="empty-state">Belum ada transaksi</p>';
    } else {
        txList.innerHTML = filtered.slice(0, 20).map(t => `
            <div class="transaction-item ${t.method === 'utang' ? 'tx-debt' : ''}">
                <div class="header">
                    <span class="date">${formatDate(t.date)}</span>
                    <span class="total">${formatRupiah(t.total)}</span>
                </div>
                <div class="items">${t.items.map(i => `${esc(i.name)} ×${i.qty}`).join(', ')}</div>
                <div class="tx-tags">
                    <span class="tx-tag">${esc(getCustomerName(t.customerId))}</span>
                    <span class="tx-tag">${t.method === 'utang' ? '🧾 Utang' : '💵 Tunai'}</span>
                    ${t.discount > 0 ? `<span class="tx-tag tag-discount">🏷️ Diskon ${formatRupiah(t.discount)}</span>` : ''}
                </div>
            </div>
        `).join('');
    }
}

// ===== CUSTOMERS =====
function renderCustomers() {
    const list = document.getElementById('customerList');
    if (customers.length === 0) {
        list.innerHTML = '<p class="empty-state">Belum ada data pelanggan</p>';
        return;
    }

    list.innerHTML = customers.map(c => {
        const custTx = transactions.filter(t => t.customerId === c.id);
        const totalSpent = custTx.reduce((sum, t) => sum + t.total, 0);
        const debt = getCustomerDebt(c.id);
        return `
            <div class="customer-card">
                <h4>👤 ${esc(c.name)}</h4>
                <div class="phone">📱 ${esc(c.phone)}</div>
                <div class="stats">
                    ${custTx.length} transaksi • ${formatRupiah(totalSpent)}
                </div>
                ${debt > 0 ? `<div class="debt-badge">🧾 Utang: ${formatRupiah(debt)}</div>` : ''}
                <div class="customer-actions">
                    ${debt > 0 ? `<button class="btn btn-success btn-sm" onclick="openPaymentModal(${parseInt(c.id) || 0})">💰 Bayar Utang</button>` : ''}
                    <button class="btn btn-secondary btn-sm" onclick="openCustomerHistory(${parseInt(c.id) || 0})">📋 Riwayat</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteCustomer(${parseInt(c.id) || 0})">🗑️ Hapus</button>
                </div>
            </div>
        `;
    }).join('');
}

function openPaymentModal(id) {
    const c = customers.find(x => x.id === id);
    if (!c) return;
    const debt = getCustomerDebt(id);
    if (debt <= 0) {
        showToast('Pelanggan ini tidak punya utang 👍');
        return;
    }
    document.getElementById('paymentCustomerId').value = id;
    document.getElementById('paymentCustomerName').value = c.name;
    document.getElementById('paymentDebtInfo').innerHTML =
        `Sisa utang saat ini: <strong>${formatRupiah(debt)}</strong>`;
    document.getElementById('paymentAmount').value = '';
    document.getElementById('paymentAmount').max = debt;
    document.getElementById('paymentNote').value = '';
    document.getElementById('paymentModal').classList.remove('hidden');
}

function closePaymentModal() {
    document.getElementById('paymentModal').classList.add('hidden');
}

function saveCustomerPayment(e) {
    e.preventDefault();
    const id = parseInt(document.getElementById('paymentCustomerId').value);
    const amount = parseInt(document.getElementById('paymentAmount').value) || 0;
    const note = document.getElementById('paymentNote').value.trim();
    const debt = getCustomerDebt(id);

    if (amount <= 0) {
        showToast('Jumlah bayar tidak valid', 'error');
        return;
    }
    if (amount > debt) {
        showToast(`Melebihi sisa utang (${formatRupiah(debt)})`, 'error');
        return;
    }

    customerPayments.unshift({
        id: Date.now(),
        customerId: id,
        amount,
        note,
        date: new Date().toISOString()
    });
    DB.set('anjani_customer_payments', customerPayments);
    closePaymentModal();
    renderCustomers();
    renderSaleCustomerOptions();
    showToast(`Pembayaran ${formatRupiah(amount)} tersimpan. Sisa utang ${formatRupiah(getCustomerDebt(id))} 💰`);
}

function openCustomerHistory(id) {
    const c = customers.find(x => x.id === id);
    if (!c) return;

    const custTx = transactions.filter(t => t.customerId === id);
    const payments = customerPayments.filter(p => p.customerId === id);
    const totalSpent = custTx.reduce((sum, t) => sum + t.total, 0);
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);

    document.getElementById('customerHistoryHead').innerHTML = `
        <div class="history-name">👤 ${esc(c.name)}</div>
        <div class="history-meta">📱 ${esc(c.phone)}</div>
        <div class="history-meta">${custTx.length} transaksi • belanja ${formatRupiah(totalSpent)}</div>
        <div class="history-meta">Sudah dibayar: ${formatRupiah(totalPaid)}</div>
        <div class="debt-badge">🧾 Sisa utang: ${formatRupiah(getCustomerDebt(id))}</div>
    `;

    const items = [
        ...custTx.map(t => ({
            date: t.date,
            kind: 'trx',
            title: t.items.map(i => `${esc(i.name)} ×${i.qty}`).join(', '),
            amount: t.total,
            badge: (t.method === 'utang' ? 'Utang' : 'Tunai') + (t.discount > 0 ? ` • diskon ${formatRupiah(t.discount)}` : '')
        })),
        ...payments.map(p => ({
            date: p.date,
            kind: 'pay',
            title: p.note ? esc(p.note) : 'Pembayaran utang',
            amount: p.amount,
            badge: 'Dibayar'
        }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    const list = document.getElementById('customerHistoryList');
    list.innerHTML = items.length === 0
        ? '<p class="empty-state">Belum ada aktivitas</p>'
        : items.map(i => `
            <div class="history-item ${i.kind}">
                <div class="history-info">
                    <div class="history-title">${i.title}</div>
                    <div class="history-date">${formatDate(i.date)} • <span class="history-badge ${i.kind}">${i.badge}</span></div>
                </div>
                <div class="history-amount ${i.kind === 'pay' ? 'amount-in' : ''}">
                    ${i.kind === 'pay' ? '-' : ''}${formatRupiah(i.amount)}
                </div>
            </div>
        `).join('');

    document.getElementById('customerHistoryModal').classList.remove('hidden');
}

function closeCustomerHistory() {
    document.getElementById('customerHistoryModal').classList.add('hidden');
}

function openCustomerModal() {
    document.getElementById('customerModal').classList.remove('hidden');
}

function closeCustomerModal() {
    document.getElementById('customerModal').classList.add('hidden');
}

function saveCustomer(e) {
    e.preventDefault();
    const newId = Date.now();
    customers.push({
        id: newId,
        name: document.getElementById('customerName').value,
        phone: document.getElementById('customerPhone').value
    });
    DB.set('anjani_customers', customers);
    closeCustomerModal();
    renderCustomers();
    renderSaleCustomerOptions();
    const sel = document.getElementById('saleCustomer');
    if (sel) sel.value = String(newId);
    showToast('Pelanggan ditambahkan');
    document.getElementById('customerName').value = '';
    document.getElementById('customerPhone').value = '';
}

function deleteCustomer(id) {
    if (!confirm('Hapus pelanggan ini?')) return;
    const hasDebt = getCustomerDebt(id) > 0;
    if (hasDebt && !confirm('Pelanggan ini masih punya utang, tetap hapus? Riwayat utangnya ikut hilang.')) return;
    customers = customers.filter(c => c.id !== id);
    customerPayments = customerPayments.filter(p => p.customerId !== id);
    DB.set('anjani_customers', customers);
    DB.set('anjani_customer_payments', customerPayments);
    renderCustomers();
    renderSaleCustomerOptions();
}

// ===== WHATSAPP ADMIN =====
const WA_NUMBER = '6282328513831'; // 082328513831 -> format internasional

function waLink(text) {
    const msg = (text || 'Halo kak, saya mau tanya-tanya dulu boleh?').trim();
    return 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(msg);
}

function openWhatsApp(text) {
    window.open(waLink(text), '_blank', 'noopener,noreferrer');
}

function toggleWaPanel(force) {
    const panel = document.getElementById('waPanel');
    const fab = document.getElementById('waFab');
    if (!panel || !fab) return;
    const open = typeof force === 'boolean' ? force : panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
    fab.classList.toggle('is-open', open);
    fab.setAttribute('aria-expanded', String(open));
    if (open) {
        const input = document.getElementById('waCustomText');
        if (input) input.value = '';
    }
}

function sendWaCustom(e) {
    e.preventDefault();
    const input = document.getElementById('waCustomText');
    const text = input ? input.value.trim() : '';
    if (!text) {
        showToast('Tulis pertanyaan dulu ya', 'error');
        if (input) input.focus();
        return;
    }
    openWhatsApp(text);
    input.value = '';
    toggleWaPanel(false);
}

document.querySelectorAll('[data-wa-msg]').forEach(el => {
    el.setAttribute('href', waLink(el.dataset.waMsg));
    el.addEventListener('click', () => toggleWaPanel(false));
});

const waFabEl = document.getElementById('waFab');
if (waFabEl) waFabEl.addEventListener('click', () => toggleWaPanel());

document.addEventListener('click', (e) => {
    const panel = document.getElementById('waPanel');
    const fab = document.getElementById('waFab');
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || (fab && fab.contains(e.target))) return;
    toggleWaPanel(false);
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleWaPanel(false);
});

// ===== BACKUP / RESTORE =====
const BACKUP_VERSION = 1;
const DATA_KEYS = [
    'anjani_products',
    'anjani_stock_history',
    'anjani_transactions',
    'anjani_customers',
    'anjani_customer_payments'
];
let pendingRestore = null;

function buildBackup() {
    const data = {};
    DATA_KEYS.forEach(key => {
        const rows = DB.get(key, []);
        data[key] = key === 'anjani_products'
            ? rows.map(p => Object.assign({}, p, { image: p.image ? resolveImage(p.image) : '' }))
            : rows;
    });
    return { app: 'Anjani Market', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
}

function validateBackup(raw) {
    if (!raw || typeof raw !== 'object' || !raw.data || typeof raw.data !== 'object') return null;
    const data = raw.data;
    let known = 0;
    for (let i = 0; i < DATA_KEYS.length; i++) {
        const key = DATA_KEYS[i];
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            if (!Array.isArray(data[key])) return null;
            known++;
        }
    }
    if (!known) return null;
    const count = key => (Array.isArray(data[key]) ? data[key].length : 0);
    return {
        products: count('anjani_products'),
        stock: count('anjani_stock_history'),
        transactions: count('anjani_transactions'),
        customers: count('anjani_customers'),
        payments: count('anjani_customer_payments')
    };
}

function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function dateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function exportBackup() {
    const json = JSON.stringify(buildBackup());
    downloadFile('anjani-market-backup-' + dateStamp() + '.json', json, 'application/json;charset=utf-8');
    showToast('Backup berhasil diunduh 💾');
}

function csvCell(value) {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
}

function transactionsToCsv(rows) {
    const header = ['Tanggal', 'Metode', 'Pelanggan', 'Item', 'Subtotal', 'Diskon', 'Total', 'Dibayar', 'Kembalian', 'Utang'];
    const lines = [header.map(csvCell).join(',')];
    rows.forEach(t => {
        lines.push([
            new Date(t.date).toLocaleString('id-ID'),
            t.method === 'utang' ? 'Utang' : 'Tunai',
            getCustomerName(t.customerId),
            (t.items || []).map(i => i.name + ' x' + i.qty).join('; '),
            t.subtotal, t.discount, t.total, t.paid, t.change, t.debt
        ].map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
}

function exportTransactionsCsv() {
    downloadFile('anjani-transaksi-' + dateStamp() + '.csv', transactionsToCsv(transactions), 'text/csv;charset=utf-8');
    showToast('CSV transaksi diunduh 📄');
}

function exportExcel() {
    if (typeof XLSX === 'undefined') {
        showToast('Modul Excel belum termuat, muat ulang halaman', 'error');
        return;
    }
    try {
        const wb = XLSX.utils.book_new();

        const txRows = transactions.map(t => ({
            'Tanggal': new Date(t.date).toLocaleString('id-ID'),
            'Metode': t.method === 'utang' ? 'Utang' : 'Tunai',
            'Pelanggan': getCustomerName(t.customerId),
            'Item': (t.items || []).map(i => `${i.name} x${i.qty}`).join('; '),
            'Subtotal': t.subtotal,
            'Diskon': t.discount,
            'Total': t.total,
            'Dibayar': t.paid,
            'Kembalian': t.change,
            'Utang': t.debt
        }));
        const wsTx = XLSX.utils.json_to_sheet(txRows);
        wsTx['!cols'] = [
            { wch: 18 }, { wch: 8 }, { wch: 18 }, { wch: 40 },
            { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 },
            { wch: 12 }, { wch: 10 }
        ];
        XLSX.utils.book_append_sheet(wb, wsTx, 'Transaksi');

        const prodRows = products.map(p => ({
            'Produk': p.name,
            'Kategori': p.category,
            'Harga Beli': p.buyPrice,
            'Harga Jual': p.sellPrice,
            'Stok': p.stock,
            'Stok Minimum': p.minStock,
            'Laba/pcs': p.sellPrice - p.buyPrice
        }));
        const wsProd = XLSX.utils.json_to_sheet(prodRows);
        wsProd['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 12 }];
        XLSX.utils.book_append_sheet(wb, wsProd, 'Produk');

        const custRows = customers.map(c => ({
            'Nama': c.name,
            'No. HP': c.phone,
            'Sisa Utang': getCustomerDebt(c.id),
            'Jumlah Transaksi': transactions.filter(t => t.customerId === c.id).length,
            'Total Belanja': transactions.filter(t => t.customerId === c.id).reduce((s, t) => s + t.total, 0)
        }));
        const wsCust = XLSX.utils.json_to_sheet(custRows);
        wsCust['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }];
        XLSX.utils.book_append_sheet(wb, wsCust, 'Pelanggan');

        const all = calcProfitReport(filterByPeriod(transactions, 'semua'));
        const sumRows = [
            { 'Ringkasan': 'Total Transaksi', 'Nilai': transactions.length },
            { 'Ringkasan': 'Omzet', 'Nilai': all.revenue },
            { 'Ringkasan': 'Modal (HPP)', 'Nilai': all.cost },
            { 'Ringkasan': 'Laba Bersih', 'Nilai': all.net },
            { 'Ringkasan': 'Margin', 'Nilai': all.margin.toFixed(1) + '%' },
            { 'Ringkasan': 'Barang Terjual', 'Nilai': all.qty }
        ];
        const wsSum = XLSX.utils.json_to_sheet(sumRows);
        wsSum['!cols'] = [{ wch: 22 }, { wch: 18 }];
        XLSX.utils.book_append_sheet(wb, wsSum, 'Ringkasan');

        XLSX.writeFile(wb, 'anjani-market-' + dateStamp() + '.xlsx');
        showToast('File Excel diunduh 📊');
    } catch (err) {
        console.log('Export Excel error:', err);
        showToast('Gagal membuat file Excel', 'error');
    }
}

function handleBackupFile(e) {
    const input = e && e.target;
    const file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => showToast('Gagal membaca file', 'error');
    reader.onload = () => {
        let raw;
        try {
            raw = JSON.parse(reader.result);
        } catch (err) {
            showToast('File bukan JSON yang valid', 'error');
            return;
        }
        const counts = validateBackup(raw);
        if (!counts) {
            showToast('Format file backup tidak dikenali', 'error');
            return;
        }
        pendingRestore = raw;
        renderRestorePreview(raw, counts);
    };
    reader.readAsText(file);
}

function renderRestorePreview(raw, counts) {
    const box = document.getElementById('restorePreview');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML =
        '<div class="restore-title">File siap dipulihkan</div>' +
        '<div class="restore-meta">' + esc(raw.app || 'Anjani Market') + ' • ' +
        (raw.exportedAt ? esc(formatDate(raw.exportedAt)) : 'tanggal tidak diketahui') + '</div>' +
        '<ul class="restore-counts">' +
        '<li><span>Produk</span><b>' + counts.products + '</b></li>' +
        '<li><span>Transaksi</span><b>' + counts.transactions + '</b></li>' +
        '<li><span>Pelanggan</span><b>' + counts.customers + '</b></li>' +
        '<li><span>Riwayat stok</span><b>' + counts.stock + '</b></li>' +
        '<li><span>Pembayaran utang</span><b>' + counts.payments + '</b></li>' +
        '</ul>' +
        '<div class="settings-actions">' +
        '<button type="button" class="btn btn-danger" onclick="confirmRestore()">⚠️ Timpa Data Sekarang</button>' +
        '<button type="button" class="btn btn-secondary" onclick="cancelRestore()">Batal</button>' +
        '</div>';
}

function cancelRestore() {
    pendingRestore = null;
    const box = document.getElementById('restorePreview');
    if (box) {
        box.classList.add('hidden');
        box.innerHTML = '';
    }
}

async function confirmRestore() {
    if (!pendingRestore) return;
    if (!window.confirm('Seluruh data saat ini akan diganti dengan isi backup. Lanjutkan?')) return;
    const raw = pendingRestore;
    cancelRestore();
    await applyRestore(raw);
}

async function applyRestore(raw) {
    if (!validateBackup(raw)) {
        showToast('File backup tidak valid', 'error');
        return false;
    }
    const data = raw.data;
    products = asList(data.anjani_products);
    stockHistory = asList(data.anjani_stock_history);
    transactions = asList(data.anjani_transactions);
    customers = asList(data.anjani_customers);
    customerPayments = asList(data.anjani_customer_payments);
    sanitizeCollections();
    for (let i = 0; i < DATA_KEYS.length; i++) {
        if (DB.set(DATA_KEYS[i], collectionByKey(DATA_KEYS[i])) === false) {
            showToast('Gagal menyimpan: penyimpanan penuh', 'error');
            return false;
        }
    }
    resetSaleForm();
    cart = [];
    renderCart();
    await migrateInlineImages();
    releaseUnusedImages();
    refreshActivePage();
    renderSaleCustomerOptions();
    showToast('Data dipulihkan dari backup ✅');
    return true;
}

function renderSettings() {
    const box = document.getElementById('storageInfo');
    if (!box) return;
    let bytes = 0;
    DATA_KEYS.forEach(key => {
        try { bytes += (localStorage.getItem(key) || '').length; } catch (err) { /* ignore */ }
    });
    const items = [
        ['Produk', products.length],
        ['Foto tersimpan', products.filter(p => p.image).length],
        ['Riwayat stok', stockHistory.length],
        ['Transaksi', transactions.length],
        ['Pelanggan', customers.length],
        ['Utang tercatat', customerPayments.length],
        ['Perkiraan data', (bytes / 1024).toFixed(1) + ' KB'],
        ['Versi backup', 'v' + BACKUP_VERSION]
    ];
    box.innerHTML = items.map(item =>
        '<div class="storage-item"><div class="k">' + esc(item[0]) + '</div><div class="v">' + esc(item[1]) + '</div></div>'
    ).join('');
}

// ===== PWA INSTALL =====
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('btnInstall').classList.remove('hidden');
});

document.getElementById('btnInstall').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
        document.getElementById('btnInstall').classList.add('hidden');
    }
    deferredPrompt = null;
});

// ===== SERVICE WORKER + UPDATE =====
let swRefreshing = false;

// Reload HANYA dipasang ketika pengguna menekan tombol "Muat ulang",
// supaya pengambilalihan SW pertama kali (clients.claim) tidak pernah
// me-reload halaman di tengah transaksi.
function armReloadOnControllerChange() {
    if (swRefreshing) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (swRefreshing) return;
        swRefreshing = true;
        window.location.reload();
    }, { once: true });
}

function notifyAppUpdate(worker) {
    if (document.getElementById('btnReloadApp')) return;
    const toast = document.getElementById('toast');
    toast.innerHTML = '🔄 Versi baru tersedia <button type="button" class="toast-action" id="btnReloadApp">Muat ulang</button>';
    toast.className = 'toast update';
    document.getElementById('btnReloadApp').addEventListener('click', () => {
        armReloadOnControllerChange();
        worker.postMessage({ type: 'SKIP_WAITING' });
        toast.classList.add('hidden');
    });
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            const reg = await navigator.serviceWorker.register('sw.js');
            if (reg.waiting && navigator.serviceWorker.controller) notifyAppUpdate(reg.waiting);
            reg.addEventListener('updatefound', () => {
                const installing = reg.installing;
                if (!installing) return;
                installing.addEventListener('statechange', () => {
                    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                        notifyAppUpdate(installing);
                    }
                });
            });
        } catch (err) {
            console.log('SW error:', err);
        }
    });
}

// ===== INIT =====
(async function init() {
    await ImageStore.init();
    sanitizeCollections();
    await migrateInlineImages();
    renderDashboard();
})();