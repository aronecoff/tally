import apache from './notices/apache-2.0.txt?raw'
import mit from './notices/mit.txt?raw'
import ofl from './notices/ofl-1.1.txt?raw'

/** What ships inside the app, for Settings' Acknowledgements. */
export const NOTICES = [
  { name: 'Instrument Serif', by: 'Copyright 2022 The Instrument Serif Project Authors', license: 'SIL Open Font License 1.1', text: ofl },
  { name: 'Dexie', by: 'By David Fahlander', license: 'Apache License 2.0', text: apache },
  { name: 'React', by: 'Copyright Meta Platforms, Inc. and affiliates', license: 'MIT License', text: mit },
]
