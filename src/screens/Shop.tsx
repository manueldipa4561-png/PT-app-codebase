import { ShoppingBag, Storefront } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { firstName, isHttpsUrl, type Product } from '../domain.ts';
import { errorText, fmtMoney, useI18n } from '../i18n.ts';
import { Button, Empty, useApp } from '../ui.tsx';

export function Shop() {
  const { api, trainer, products, toast } = useApp();
  const { t, lang } = useI18n();

  function buy(p: Product) {
    // Stripe Payment Link in the trainer's own Stripe account: money never passes through us.
    if (api.mode === 'demo') toast(t('shop.demo'));
    else if (isHttpsUrl(p.paymentUrl)) window.open(p.paymentUrl, '_blank', 'noopener,noreferrer');
    else toast(errorText(t, 'generic'), 'error'); // the database only accepts https, so this is defense in depth
  }

  return (
    <>
      <h1 className="page-title display">{t('shop.title')}</h1>
      <p className="page-lead">
        {t('shop.secure', { trainer: firstName(trainer.name) })} {t('shop.pickup')}.
      </p>
      <section className="pad section">
        {products.length === 0 ? (
          <Empty icon={<Storefront size={26} />} title={t('shop.empty')} />
        ) : (
          <motion.div className="products" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05 } } }}>
            {products.map((p) => (
              <motion.div key={p.id} className="product" variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }}>
                <span className="product-art" aria-hidden>
                  {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <ShoppingBag size={40} weight="duotone" />}
                </span>
                <span className="product-name">{p.name}</span>
                {p.description && <span className="product-desc">{p.description}</span>}
                <span className="product-foot">
                  <span className="product-price">{fmtMoney(p.priceCents, trainer.currency, lang)}</span>
                  <Button block onClick={() => buy(p)}>
                    {t('shop.buy')}
                  </Button>
                </span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </section>
    </>
  );
}
