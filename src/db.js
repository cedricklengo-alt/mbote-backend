/**
 * Sélecteur de base de données :
 *   - DATABASE_URL défini  → PostgreSQL (production, données persistantes)
 *   - sinon                → SQLite (développement local, zéro config)
 * Les deux drivers exposent exactement la même interface asynchrone :
 *   init() · get(sql, params) · all(sql, params) · run(sql, params) · tx(fn) · fn (dialecte)
 */
require('dotenv').config();

module.exports = process.env.DATABASE_URL
  ? require('./db/pg')
  : require('./db/sqlite');
