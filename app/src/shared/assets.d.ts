declare module '*?url' {
  const url: string
  export default url
}

declare module 'sql.js/dist/sql-wasm-inline.js' {
  import initSqlJs from 'sql.js'
  export default initSqlJs
}
