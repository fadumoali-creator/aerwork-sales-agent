// Puhdas, testattava kasvun suunta -logiikka. EI hae eikä keksi taloustietoa
// itse - ottaa vastaan jo saadut liikevaihtoluvut kahdelta tilikaudelta ja
// palauttaa vain suunnan + prosentin. Valmis käytettäväksi heti kun oikea
// taloustietolähde (ks. data_sources: 'financial_data') joskus liitetään.
//
// Säännöt (spesifikaation mukaan):
//   > +3%      -> kasvaa
//   -3% .. +3% -> vakaa
//   < -3%      -> laskee
//   vertailutietoa ei saatavilla -> ei_tietoa

'use strict';

function calcGrowthDirection(currentRevenue, previousRevenue) {
  if (currentRevenue === null || currentRevenue === undefined ||
      previousRevenue === null || previousRevenue === undefined ||
      !isFinite(currentRevenue) || !isFinite(previousRevenue) || previousRevenue === 0) {
    return { direction: 'ei_tietoa', percent: null };
  }
  const percent = ((currentRevenue - previousRevenue) / Math.abs(previousRevenue)) * 100;
  const rounded = Math.round(percent * 10) / 10;
  const direction = rounded > 3 ? 'kasvaa' : rounded < -3 ? 'laskee' : 'vakaa';
  return { direction, percent: rounded };
}

const GROWTH_DIRECTION_LABEL = {
  kasvaa: { label: 'Kasvaa', icon: '↑', className: 'growth-up' },
  vakaa: { label: 'Vakaa', icon: '→', className: 'growth-flat' },
  laskee: { label: 'Laskee', icon: '↓', className: 'growth-down' },
  ei_tietoa: { label: 'Ei tietoa', icon: '', className: 'growth-unknown' }
};

module.exports = { calcGrowthDirection, GROWTH_DIRECTION_LABEL };
