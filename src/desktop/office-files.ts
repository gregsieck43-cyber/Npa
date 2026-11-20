import { strToU8, zipSync } from 'fflate';
import pptxgen from 'pptxgenjs';

const xml = (text: string) => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export type OfficeFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf';

function officePackage(kind: 'word' | 'xl', parts: Record<string,string>) {
  const word = kind === 'word', main = word ? 'word/document.xml' : 'xl/workbook.xml';
  const family = word ? 'wordprocessingml.document' : 'spreadsheetml.sheet';
  const files: Record<string,string> = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/' + main + '" ContentType="application/vnd.openxmlformats-officedocument.' + family + '.main+xml"/>' + (word ? '' : '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>') + '</Types>',
    '_rels/.rels': '<Relationships xmlns="' + rel + '"><Relationship Id="r1" Type="' + office + '/officeDocument" Target="' + main + '"/></Relationships>',
    ...parts
  };
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, body]) => [name, strToU8(declaration + body)]))));
}
export async function createOfficeFile(format: Exclude<OfficeFormat,'pdf'>, text: string) {
  const lines = text.split(/\r?\n/);
  if (format === 'docx') {
    const body = lines.map(line => '<w:p><w:r>' + (line.startsWith('#') ? '<w:rPr><w:b/></w:rPr>' : '') + '<w:t xml:space="preserve">' + xml(line.replace(/^#{1,6}\s+/, '')) + '</w:t></w:r></w:p>').join('');
    return officePackage('word', { 'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '<w:sectPr/></w:body></w:document>' });
  }
  if (format === 'xlsx') {
    const rows = lines.filter(line => line.trim() && !/^\s*\|?[\s:|-]+\|?\s*$/.test(line)).map(line => {
      const cells = line.includes('|') ? line.trim().replace(/^\||\|$/g, '').split('|') : line.split('\t');
      return '<row>' + cells.map(value => /^-?\d+(?:\.\d+)?$/.test(value.trim()) && !/^0\d/.test(value.trim()) ? '<c><v>' + value.trim() + '</v></c>' : '<c t="inlineStr"><is><t xml:space="preserve">' + xml(value.trim()) + '</t></is></c>').join('') + '</row>';
    });
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    return officePackage('xl', {
      'xl/workbook.xml': '<workbook xmlns="' + ns + '" xmlns:r="' + office + '"><sheets><sheet name="工作表" sheetId="1" r:id="r1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships xmlns="' + rel + '"><Relationship Id="r1" Type="' + office + '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet xmlns="' + ns + '"><sheetData>' + rows.join('') + '</sheetData></worksheet>'
    });
  }
  const Presentation = pptxgen as unknown as typeof import('pptxgenjs').default;
  const deck = new Presentation();
  deck.layout = 'LAYOUT_WIDE';
  let title = '工作汇报', paragraphs: string[] = [], slides = 0;
  const addSlide = () => {
    const slide = deck.addSlide(); slides++;
    slide.addText(title, { x: 0.65, y: 0.5, w: 12, h: 0.85, fontSize: 30, bold: true, color: '322F2C', fit: 'shrink' });
    slide.addText(paragraphs.join('\n'), { x: 0.65, y: 1.6, w: 12, h: 5.3, fontSize: 20, color: '433D39', valign: 'top', fit: 'shrink' });
    paragraphs = [];
  };
  for (const line of lines.filter(line => line.trim())) {
    if (/^#{1,3}\s/.test(line)) { if (paragraphs.length) addSlide(); title = line.replace(/^#+\s*/, ''); }
    else { paragraphs.push(line); if (paragraphs.join('').length > 600 || paragraphs.length >= 10) addSlide(); }
  }
  if (paragraphs.length || !slides) addSlide();
  return Buffer.from(await deck.write({ outputType: 'nodebuffer' }) as Uint8Array);
}
