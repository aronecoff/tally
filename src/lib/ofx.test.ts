/** Reading OFX and QFX statements. Every account, id and merchant here is invented. */
import { describe, expect, it } from 'vitest'
import { isOfx, parseOfx } from './ofx'

const SGML_BANK = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261105120000<LANGUAGE>ENG
<FI><ORG>Test Credit Union<FID>9999</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>USD
<BANKACCTFROM><BANKID>000000000<ACCTID>00001234<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261101
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261103120000.000[-8:PST]
<TRNAMT>-4.50
<FITID>T-1
<NAME>HARBOR COFFEE
<MEMO>POS PURCHASE
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261102<TRNAMT>3200.00<FITID>T-2<NAME>ACME PAYROLL</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1000.00<DTASOF>20261105</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`

const XML_CARD = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <CREDITCARDMSGSRSV1>
    <CCSTMTTRNRS>
      <CCSTMTRS>
        <CURDEF>USD</CURDEF>
        <CCACCTFROM><ACCTID>4000000000005678</ACCTID></CCACCTFROM>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE>
            <DTPOSTED>20261103</DTPOSTED>
            <TRNAMT>-12.00</TRNAMT>
            <FITID>C-1</FITID>
            <NAME>AT&amp;T WIRELESS</NAME>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20261104</DTPOSTED>
            <TRNAMT>5.00</TRNAMT>
            <FITID>C-2</FITID>
            <MEMO>Caf&#233; refund</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
      </CCSTMTRS>
    </CCSTMTTRNRS>
  </CREDITCARDMSGSRSV1>
</OFX>`

describe('isOfx', () => {
  it('knows both forms by what is in them', () => {
    expect(isOfx(SGML_BANK)).toBe(true)
    expect(isOfx(XML_CARD)).toBe(true)
    expect(isOfx('<OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>')).toBe(true)
  })

  it('leaves a CSV alone, even one that mentions the word', () => {
    expect(isOfx('Date,Description,Amount\n2026-11-03,OFX EXPORT FEE,-1.00\n')).toBe(false)
    expect(isOfx('')).toBe(false)
  })
})

describe('parseOfx', () => {
  it('reads an SGML bank statement, with leaves that have no closing tag', () => {
    const { org, statements } = parseOfx(SGML_BANK)
    expect(org).toBe('Test Credit Union')
    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatchObject({ card: false, account: '00001234' })
    expect(statements[0].rows).toEqual([
      { id: 'T-1', date: '2026-11-03', amount: '-4.50', name: 'HARBOR COFFEE', memo: 'POS PURCHASE' },
      { id: 'T-2', date: '2026-11-02', amount: '3200.00', name: 'ACME PAYROLL', memo: '' },
    ])
  })

  it('reads an XML card statement, and knows it is a card', () => {
    const { statements } = parseOfx(XML_CARD)
    expect(statements[0]).toMatchObject({ card: true, account: '4000000000005678' })
    expect(statements[0].rows.map((r) => r.amount)).toEqual(['-12.00', '5.00'])
  })

  it('reads what a character reference stands for', () => {
    const [first, second] = parseOfx(XML_CARD).statements[0].rows
    expect(first.name).toBe('AT&T WIRELESS')
    expect(second.memo).toBe('Café refund')
  })

  it('keeps the day as written, whatever the zone says', () => {
    const late = '<OFX><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>20261103233000[-8:PST]<TRNAMT>-1<FITID>1</STMTTRN></BANKTRANLIST></STMTRS></OFX>'
    expect(parseOfx(late).statements[0].rows[0].date).toBe('2026-11-03')
  })

  it('leaves a date that cannot be read as it stands, for the row to be left out and shown', () => {
    const odd = '<OFX><STMTRS><STMTTRN><DTPOSTED>soon<TRNAMT>-1<FITID>1</STMTTRN></STMTRS></OFX>'
    expect(parseOfx(odd).statements[0].rows[0].date).toBe('soon')
  })

  it('does not lose a row when the closing tag is missing', () => {
    const open = '<OFX><STMTRS><STMTTRN><DTPOSTED>20261103<TRNAMT>-1<FITID>1<STMTTRN><DTPOSTED>20261104<TRNAMT>-2<FITID>2</STMTRS></OFX>'
    expect(parseOfx(open).statements[0].rows.map((r) => r.id)).toEqual(['1', '2'])
  })

  it('keeps two statements in one file apart', () => {
    const two = `<OFX>
      <STMTRS><BANKACCTFROM><ACCTID>111</BANKACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-1<FITID>1</STMTTRN></STMTRS>
      <CCSTMTRS><CCACCTFROM><ACCTID>222</CCACCTFROM><STMTTRN><DTPOSTED>20261103<TRNAMT>-2<FITID>1</STMTTRN></CCSTMTRS>
    </OFX>`
    const { statements } = parseOfx(two)
    expect(statements.map((s) => [s.account, s.card, s.rows.length])).toEqual([['111', false, 1], ['222', true, 1]])
  })

  it('reads a credit line as a card', () => {
    const line = '<OFX><STMTRS><BANKACCTFROM><ACCTID>111<ACCTTYPE>CREDITLINE</BANKACCTFROM></STMTRS></OFX>'
    expect(parseOfx(line).statements[0].card).toBe(true)
  })

  it('finds nothing in a file with no statement', () => {
    expect(parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>').statements).toEqual([])
    expect(parseOfx('not a statement').statements).toEqual([])
  })
})
