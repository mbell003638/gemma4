import { chooseGemmaProposalFamily, chooseGemmaReadBundle } from '../src/accountingV2/gemma/liveGemmaAsk';
import fs from 'fs';
import path from 'path';

describe('Gemma live Ask routing', () => {
  test.each([
    ['show my profit and loss', 'reports'],
    ['how much cash is in the bank?', 'cash'],
    ['what does customer Arjun owe?', 'parties'],
    ['find journal entry INV-4', 'entries'],
    ['show stock valuation', 'inventory'],
    ['show partner capital and drawings', 'businessAccounts'],
    ['what can this app do?', 'capabilities'],
  ])('%s selects %s', (question, expected) => {
    expect(chooseGemmaReadBundle(question)).toBe(expected);
  });
});

describe('Gemma live proposal routing', () => {
  test.each([
    ['record a supplier bill', 'bills'],
    ['create an invoice', 'invoices'],
    ['record partner capital', 'businessAccounts'],
    ['count inventory', 'inventory'],
    ['I spent 50 on fuel', 'expenses'],
    ['record a sale', 'sales'],
    ['add a new supplier', 'parties'],
    ['create customer Rahul', 'parties'],
    ['what can this app do?', null],
  ])('%s selects only %s proposal tools', (question, expected) => {
    expect(chooseGemmaProposalFamily(question)).toBe(expected);
  });

  it('passes the trusted UI proposal permission into the agent', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/accountingV2/gemma/liveGemmaAsk.ts'), 'utf8');
    expect(source).toContain('return deps.run(tools, currentScope, runtime, question, allowProposals)');
    expect(source).toContain('canPropose,');
    expect(source).not.toContain('canPropose: false');
  });
});
