/** Fournisseur airtime DÉMO — succès immédiat simulé.
 *  Cas d'échec simulé : numéro finissant par 0002. */
module.exports = {
  name: 'demo',
  async send({ phone, amountCents }) {
    if (String(phone).endsWith('0002')) throw new Error('Opérateur injoignable (simulation)');
    console.log(`📱 [DEMO] Airtime envoyé : ${(amountCents / 100).toFixed(2)} $ → ${phone}`);
    return { reference: 'demo_air_' + Date.now() };
  },
};
