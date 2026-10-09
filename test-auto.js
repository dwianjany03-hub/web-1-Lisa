// ===== ANJANI MARKET - AUTO TEST SCRIPT =====
// Copy-paste ini ke Console (F12) di http://localhost:8000 lalu Enter
// Akan menjalankan seluruh alur & mencatat PASS/FAIL

(async function runTests() {
  const results = [];
  function log(name, ok, detail = '') {
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`);
    results.push({ name, ok, detail });
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  // Helper: tunggu render selesai
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ---------- 1. PRODUCTS ----------
  try {
    // Tambah produk baru
    document.getElementById('productName').value = 'Test Produk Auto';
    document.getElementById('productCategory').value = 'Sembako';
    document.getElementById('productBuyPrice').value = '10000';
    document.getElementById('productSellPrice').value = '15000';
    document.getElementById('productStock').value = '20';
    document.getElementById('productMinStock').value = '5';
    await saveProduct({ preventDefault: () => {} });
    await wait(100);
    const p = products.find(x => x.name === 'Test Produk Auto');
    assert(p, 'Produk tidak tersimpan');
    log('Tambah produk', true, `id=${p.id}`);

    // Edit produk
    openProductModal(p);
    await wait(50);
    document.getElementById('productSellPrice').value = '16000';
    await saveProduct({ preventDefault: () => {} });
    await wait(100);
    const p2 = products.find(x => x.id === p.id);
    assert(p2.sellPrice === 16000, 'Edit tidak tersimpan');
    log('Edit produk', true);

    // Hapus produk
    deleteProduct(p.id);
    await wait(100);
    assert(!products.find(x => x.id === p.id), 'Produk tidak terhapus');
    log('Hapus produk', true);
  } catch (e) {
    log('Produk CRUD', false, e.message);
  }

  // ---------- 2. STOK ----------
  try {
    // Stok masuk
    openStockModal('masuk');
    await wait(50);
    document.getElementById('stockProduct').value = String(products[0].id);
    document.getElementById('stockAmount').value = '5';
    document.getElementById('stockNote').value = 'Test masuk';
    await saveStockChange({ preventDefault: () => {} });
    await wait(100);
    const hist = stockHistory.find(h => h.note === 'Test masuk' && h.type === 'masuk');
    assert(hist, 'Stok masuk tidak tercatat');
    log('Stok masuk', true);

    // Stok keluar
    openStockModal('keluar');
    await wait(50);
    document.getElementById('stockProduct').value = String(products[0].id);
    document.getElementById('stockAmount').value = '2';
    document.getElementById('stockNote').value = 'Test keluar';
    await saveStockChange({ preventDefault: () => {} });
    await wait(100);
    const hist2 = stockHistory.find(h => h.note === 'Test keluar' && h.type === 'keluar');
    assert(hist2, 'Stok keluar tidak tercatat');
    log('Stok keluar', true);
  } catch (e) {
    log('Stok CRUD', false, e.message);
  }

  // ---------- 3. PELANGGAN ----------
  try {
    // Tambah pelanggan
    document.getElementById('customerName').value = 'Test Pelanggan';
    document.getElementById('customerPhone').value = '0811112222';
    await saveCustomer({ preventDefault: () => {} });
    await wait(100);
    const c = customers.find(x => x.name === 'Test Pelanggan');
    assert(c, 'Pelanggan tidak tersimpan');
    log('Tambah pelanggan', true, `id=${c.id}`);

    // Riwayat pelanggan
    openCustomerHistory(c.id);
    await wait(100);
    const modal = document.getElementById('customerHistoryModal');
    assert(modal && !modal.classList.contains('hidden'), 'Modal riwayat tidak buka');
    closeCustomerHistory();
    log('Buka riwayat pelanggan', true);

    // Hapus pelanggan
    deleteCustomer(c.id);
    await wait(100);
    assert(!customers.find(x => x.id === c.id), 'Pelanggan tidak terhapus');
    log('Hapus pelanggan', true);
  } catch (e) {
    log('Pelanggan CRUD', false, e.message);
  }

  // ---------- 4. PENJUALAN (TUNAI) ----------
  try {
    resetSaleForm();
    await wait(50);

    // Tambah ke keranjang
    const prod = products[0];
    addToCart(prod.id);
    await wait(50);
    assert(cart.length === 1 && cart[0].qty === 1, 'Item tidak masuk keranjang');
    log('Tambah ke keranjang', true);

    // Update qty
    updateCartQty(prod.id, 1);
    await wait(50);
    assert(cart[0].qty === 2, 'Qty tidak naik');
    log('Update qty +', true);

    updateCartQty(prod.id, -1);
    await wait(50);
    assert(cart[0].qty === 1, 'Qty tidak turun');
    log('Update qty -', true);

    // Diskon Rp
    document.getElementById('saleDiscount').value = '1000';
    document.getElementById('saleDiscountType').value = 'rp';
    renderCart();
    await wait(50);
    const t1 = getCartTotals();
    assert(t1.discount === 1000, 'Diskon Rp salah');
    log('Diskon Rp', true);

    // Diskon %
    document.getElementById('saleDiscount').value = '10';
    document.getElementById('saleDiscountType').value = 'percent';
    renderCart();
    await wait(50);
    const t2 = getCartTotals();
    const expected = Math.round(t2.subtotal * 0.1);
    assert(t2.discount === expected, `Diskon % salah: ${t2.discount} vs ${expected}`);
    log('Diskon %', true);

    // Bayar tunai
    document.getElementById('saleDiscount').value = '0';
    document.getElementById('saleDiscountType').value = 'rp';
    document.getElementById('salePaid').value = String(prod.sellPrice * 2); // uang cukup
    renderCart();
    await wait(50);
    processSale('tunai');
    await wait(150);
    const lastTx = transactions[0];
    assert(lastTx && lastTx.method === 'tunai', 'Transaksi tunai tidak tersimpan');
    log('Proses tunai', true, `total=${lastTx.total}`);

    // Cek stok berkurang
    const prodAfter = products.find(x => x.id === prod.id);
    assert(prodAfter.stock === prod.stock - 1, 'Stok tidak berkurang');
    log('Stok berkurang setelah jual', true);
  } catch (e) {
    log('Penjualan Tunai', false, e.message);
  }

  // ---------- 5. LAPORAN ----------
  try {
    // Ganti periode
    document.querySelector('[data-period="mingguan"]').click();
    await wait(100);
    assert(currentReportPeriod === 'mingguan', 'Periode tidak berubah');
    log('Ganti periode laporan', true);

    // Cek elemen profit
    const netEl = document.getElementById('profitNet');
    assert(netEl && netEl.textContent, 'Profit tidak render');
    log('Render profit report', true);
  } catch (e) {
    log('Laporan', false, e.message);
  }

  // ---------- 6. BACKUP / RESTORE ----------
  try {
    // Export backup
    exportBackup();
    await wait(200);
    log('Export backup', true, 'File diunduh (cek Downloads)');

    // Export CSV
    exportTransactionsCsv();
    await wait(200);
    log('Export CSV', true);

    // Export Excel
    exportExcel();
    await wait(200);
    log('Export Excel', true);
  } catch (e) {
    log('Export', false, e.message);
  }

  // ---------- 7. PWA / SW ----------
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      assert(reg, 'SW tidak terdaftar');
      log('Service Worker', true, `scope=${reg.scope}`);
    } else {
      log('Service Worker', false, 'Browser tidak support');
    }
  } catch (e) {
    log('Service Worker', false, e.message);
  }

  // ---------- 8. STORAGE INFO ----------
  try {
    renderSettings();
    await wait(50);
    const box = document.getElementById('storageInfo');
    assert(box && box.children.length > 0, 'Storage info kosong');
    log('Storage info', true);
  } catch (e) {
    log('Storage info', false, e.message);
  }

  // ---------- RINGKASAN ----------
  console.log('\n========== RINGKASAN ==========');
  const pass = results.filter(r => r.ok).length;
  const fail = results.filter(r => !r.ok).length;
  console.log(`Total: ${results.length} | ✅ ${pass} | ❌ ${fail}`);
  if (fail) {
    console.log('\nGAGAL:');
    results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  } else {
    console.log('\n🎉 SEMUA TEST LULUS');
  }
})();