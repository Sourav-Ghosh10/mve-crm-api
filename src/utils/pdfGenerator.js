const PDFDocument = require('pdfkit');
const moment = require('moment');
const SystemSettings = require('../models/SystemSettings');
const Payslip = require('../models/Payslip');

const NAVY = '#174A7C';
const BLUE = '#1796D2';
const BORDER = '#D6E0EC';
const MUTED = '#52647B';

function numberToWords(num) {
  const ones = [
    '',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
    'Ten',
    'Eleven',
    'Twelve',
    'Thirteen',
    'Fourteen',
    'Fifteen',
    'Sixteen',
    'Seventeen',
    'Eighteen',
    'Nineteen',
  ];
  const tens = [
    '',
    '',
    'Twenty',
    'Thirty',
    'Forty',
    'Fifty',
    'Sixty',
    'Seventy',
    'Eighty',
    'Ninety',
  ];
  const convert = (n) => {
    if (n < 20) return ones[n];
    if (n < 100) return `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`;
    if (n < 1000)
      return `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` and ${convert(n % 100)}` : ''}`;
    if (n < 100000)
      return `${convert(Math.floor(n / 1000))} Thousand${n % 1000 ? ` ${convert(n % 1000)}` : ''}`;
    if (n < 10000000)
      return `${convert(Math.floor(n / 100000))} Lakh${n % 100000 ? ` ${convert(n % 100000)}` : ''}`;
    return String(n);
  };
  return Number(num) === 0 ? 'Zero' : convert(Math.floor(Number(num)));
}

const money = (amount, symbol) => `${symbol ? `${symbol} ` : ''}${Number(amount || 0).toFixed(2)}`;

const getFinancialYear = (payslip) => {
  const startYear = payslip.month >= 4 ? payslip.year : payslip.year - 1;
  return {
    label: `${startYear} - ${startYear + 1} (Apr-Mar)`,
    start: new Date(startYear, 3, 1),
    end: new Date(startYear + 1, 2, 31, 23, 59, 59),
  };
};

const generatePayslipPDF = async (payslip, user) => {
  const [signatureSetting, currencyNameSetting, currencySymbolSetting] = await Promise.all([
    SystemSettings.findOne({ key: 'payslip_signature' }),
    SystemSettings.findOne({ key: 'currency_name' }),
    SystemSettings.findOne({ key: 'currency_symbol' }),
  ]);
  const currencyName = currencyNameSetting?.value || 'Rupees';
  const currencySymbol = currencySymbolSetting?.value || 'Rs.';
  const fy = getFinancialYear(payslip);
  const periodEnd = new Date(payslip.year, payslip.month, 0, 23, 59, 59);
  const ytdPeriodQuery =
    payslip.month >= 4
      ? { year: payslip.year, month: { $gte: 4, $lte: payslip.month } }
      : {
          $or: [
            { year: fy.start.getFullYear(), month: { $gte: 4 } },
            { year: payslip.year, month: { $lte: payslip.month } },
          ],
        };
  const ytdPayslips = await Payslip.find({
    employeeId: payslip.employeeId,
    status: { $ne: 'CANCELLED' },
    ...ytdPeriodQuery,
  }).lean();
  const ytdByCode = new Map();
  ytdPayslips.forEach((slip) =>
    (slip.items || []).forEach((item) => {
      const key = item.code || item.name;
      ytdByCode.set(key, (ytdByCode.get(key) || 0) + Number(item.amount || 0));
    })
  );
  const ytdGross = ytdPayslips.reduce((sum, slip) => sum + Number(slip.grossEarnings || 0), 0);
  const ytdDeductions = ytdPayslips.reduce(
    (sum, slip) => sum + Number(slip.totalDeductions || 0),
    0
  );
  const ytdNet = ytdPayslips.reduce((sum, slip) => sum + Number(slip.netPay || 0), 0);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 38, size: 'A4' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const left = 42;
      const width = 511;
      const right = left + width;
      const monthName = moment()
        .month(payslip.month - 1)
        .format('MMMM');
      const employee =
        `${user.personalInfo?.firstName || ''} ${user.personalInfo?.lastName || ''}`.trim() ||
        'Employee';
      const empId = user.employeeId || user.employment?.employeeId || '';
      const designation = user.employment?.designation?.name || user.employment?.designation || '-';
      const doj = user.employment?.dateOfJoining
        ? moment(user.employment.dateOfJoining).format('DD/MM/YYYY')
        : '-';
      const email = user.personalInfo?.email || '-';
      const annualCtc = Number(payslip.monthlyCTC || 0) * 12;
      const sectionTitle = (title, y) => {
        doc.rect(left, y, 3, 18).fill(BLUE);
        doc
          .fillColor(NAVY)
          .font('Helvetica-Bold')
          .fontSize(9.5)
          .text(title, left + 9, y + 4);
      };
      const line = (y) =>
        doc.strokeColor(BORDER).lineWidth(0.6).moveTo(left, y).lineTo(right, y).stroke();
      const cellText = (text, x, y, w, align = 'left', bold = false) =>
        doc
          .fillColor(bold ? NAVY : '#14233A')
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8.2)
          .text(String(text || '-'), x + 6, y + 6, { width: w - 12, align, lineBreak: false });

      const logoPath = require('path').join(__dirname, '../../..', 'mve-crm-employee', 'public', 'logo.png');
      try {
        // Increased logo size and moved it slightly up to align nicely
        doc.image(logoPath, left - 10, 15, { fit: [110, 90] });
      } catch (e) {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('AM PRO STAFF', left, 45);
      }

      // Shift text further right to accommodate the larger logo
      const textLeft = left + 105;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text('AA SERVICES', textLeft, 26);
      
      doc.fillColor(MUTED).font('Helvetica').fontSize(8);
      doc.text('Second Floor, Nasuja Building 1-89/G/36, Shilpi Valley, Plot no 36,', textLeft, 44);
      doc.text('Opposite Westin Hotel Madhapur, HITEC City, Hyderabad,', textLeft, 54);
      doc.text('Telangana, India – 500081', textLeft, 64);
      doc.text('Email: annie@myvirtualemployee.com.au', textLeft, 74);
      doc.text('Contact: +91 74166 74188', textLeft, 84);

      doc.roundedRect(right - 130, 48, 130, 26, 4).fill(NAVY);
      doc
        .fillColor('white')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('SALARY PAYSLIP', right - 130, 57, { width: 130, align: 'center' });
      doc.strokeColor(NAVY).lineWidth(1.5).moveTo(left, 100).lineTo(right, 100).stroke();

      sectionTitle('1. PAY & EMPLOYEE SUMMARY', 109);
      const summaryY = 132;
      const summaryRow = 23;
      const cols = [93, 165, 93, 160];
      const summary = [
        [
          'Pay Period',
          `${monthName} ${payslip.year}`,
          'Pay Date',
          moment(periodEnd).format('DD/MM/YYYY'),
        ],
        ['Financial Year (FY)', fy.label, 'Payment Mode', 'Bank Transfer'],
        ['Employee Name', employee, 'Designation', designation],
        ['Employee ID', empId, 'Date of Joining', doj],
        ['Email Address', email, 'Annual CTC', money(annualCtc, currencySymbol)],
      ];
      doc
        .strokeColor(BORDER)
        .lineWidth(0.6)
        .rect(left, summaryY, width, summaryRow * summary.length)
        .stroke();
      summary.forEach((row, i) => {
        let x = left;
        row.forEach((value, index) => {
          cellText(value, x, summaryY + i * summaryRow, cols[index], 'left', index % 2 === 0);
          x += cols[index];
        });
        line(summaryY + (i + 1) * summaryRow);
      });
      [cols[0], cols[0] + cols[1], cols[0] + cols[1] + cols[2]].forEach((offset) =>
        doc
          .moveTo(left + offset, summaryY)
          .lineTo(left + offset, summaryY + summaryRow * summary.length)
          .stroke()
      );

      const attendanceTitleY = 254;
      sectionTitle('2. ATTENDANCE & LEAVE RECORD', attendanceTitleY);
      const attendanceY = 277;
      const attendanceCols = [104, 82, 82, 77, 86, 80];
      const attendance = [
        'Payable Days',
        'Total Cycle Days',
        'LOP Days',
        'Paid Leave',
        'Attendance Status',
        'Leave Balance',
      ];
      const attendanceValues = [
        payslip.daysWorked,
        payslip.totalDays,
        payslip.lopDays,
        Math.max(
          0,
          Number(payslip.daysWorked || 0) -
            (Number(payslip.totalDays || 0) - Number(payslip.lopDays || 0))
        ),
        'Calculated',
        '-',
      ];
      doc.strokeColor(BORDER).rect(left, attendanceY, width, 42).stroke();
      let x = left;
      attendance.forEach((label, i) => {
        cellText(label, x, attendanceY, attendanceCols[i], 'left', true);
        cellText(
          attendanceValues[i],
          x,
          attendanceY + 20,
          attendanceCols[i],
          i === 5 ? 'right' : 'left',
          i === 5
        );
        if (i)
          doc
            .moveTo(x, attendanceY)
            .lineTo(x, attendanceY + 42)
            .stroke();
        x += attendanceCols[i];
      });
      line(attendanceY + 20);

      const breakdownTitleY = 328;
      sectionTitle(
        '3. MONTHLY SALARY BREAKDOWN & FINANCIAL YEAR YTD (01 APR - 31 MAR)',
        breakdownTitleY
      );
      const tableY = 351;
      const tableCols = [111, 72, 72, 111, 72, 73];
      const earnings = (payslip.items || []).filter((item) => item.type === 'ALLOWANCE');
      const deductions = (payslip.items || []).filter((item) => item.type === 'DEDUCTION');
      const rows = Math.max(5, earnings.length, deductions.length);
      // A compact row keeps common configurations on the same single-page layout
      // as the approved payslip reference.
      const rowHeight = 16;
      doc.rect(left, tableY, width, rowHeight).fill(NAVY);
      const headers = [
        'Earnings',
        `Current (${currencySymbol})`,
        `YTD (${currencySymbol})`,
        'Deductions',
        `Current (${currencySymbol})`,
        `YTD (${currencySymbol})`,
      ];
      x = left;
      headers.forEach((header, i) => {
        doc
          .fillColor('white')
          .font('Helvetica-Bold')
          .fontSize(7.6)
          .text(header, x + 6, tableY + 6, {
            width: tableCols[i] - 12,
            align: i % 3 ? 'right' : 'left',
          });
        x += tableCols[i];
      });
      const dataY = tableY + rowHeight;
      doc
        .strokeColor(BORDER)
        .rect(left, dataY, width, rowHeight * (rows + 1))
        .stroke();
      x = left;
      tableCols.slice(0, -1).forEach((col) => {
        x += col;
        doc
          .moveTo(x, tableY)
          .lineTo(x, dataY + rowHeight * (rows + 1))
          .stroke();
      });
      for (let i = 0; i < rows; i += 1) {
        const earn = earnings[i];
        const deduction = deductions[i];
        const values = [
          earn?.name || '',
          earn ? money(earn.amount, '') : '',
          earn ? money(ytdByCode.get(earn.code || earn.name), '') : '',
          deduction?.name || '',
          deduction ? money(deduction.amount, '') : '',
          deduction ? money(ytdByCode.get(deduction.code || deduction.name), '') : '',
        ];
        x = left;
        values.forEach((value, j) => {
          cellText(value, x, dataY + i * rowHeight, tableCols[j], j % 3 ? 'right' : 'left');
          x += tableCols[j];
        });
        line(dataY + (i + 1) * rowHeight);
      }
      const totalY = dataY + rows * rowHeight;
      const totals = [
        'Total Gross Earnings (A)',
        money(payslip.grossEarnings, currencySymbol),
        money(ytdGross, currencySymbol),
        'Total Deductions (B)',
        money(payslip.totalDeductions, currencySymbol),
        money(ytdDeductions, currencySymbol),
      ];
      x = left;
      totals.forEach((value, i) => {
        cellText(value, x, totalY, tableCols[i], i % 3 ? 'right' : 'left', true);
        x += tableCols[i];
      });

      const netY = totalY + rowHeight + 10;
      doc.roundedRect(left, netY, width, 49, 5).fill(NAVY);
      doc
        .fillColor('white')
        .font('Helvetica-Bold')
        .fontSize(12)
        .text('NET SALARY PAYABLE (A - B)', left + 12, netY + 13);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .text(
          `Amount in Words: ${currencyName} ${numberToWords(payslip.netPay)} Only`,
          left + 12,
          netY + 31
        );
      doc
        .font('Helvetica-Bold')
        .fontSize(17)
        .text(money(payslip.netPay, currencySymbol), right - 150, netY + 14, {
          width: 136,
          align: 'right',
        });

      const ytdTitleY = netY + 60;
      sectionTitle('4. YEAR TO DATE (YTD) SUMMARY - FINANCIAL YEAR (01 APR - 31 MAR)', ytdTitleY);
      const ytdY = ytdTitleY + 24;
      doc.roundedRect(left, ytdY, width, 69, 4).strokeColor('#AFC4DD').lineWidth(0.8).stroke();
      const monthsElapsed = Math.max(
        1,
        Math.min(12, moment(periodEnd).diff(moment(fy.start), 'months') + 1)
      );
      const ytdRows = [
        [
          'Financial Year Cycle:',
          `${moment(fy.start).format('DD-MMM-YYYY')} to ${moment(fy.end).format('DD-MMM-YYYY')}`,
          'YTD Gross Earnings:',
          money(ytdGross, currencySymbol),
        ],
        [
          'Months Elapsed:',
          `${monthsElapsed} Months`,
          'YTD Total Deductions:',
          money(ytdDeductions, currencySymbol),
        ],
        [
          'Pay Date of Record:',
          moment(periodEnd).format('DD-MMM-YYYY'),
          'YTD Net Salary Paid:',
          money(ytdNet, currencySymbol),
        ],
      ];
      const ytdCols = [136, 145, 145, 85];
      ytdRows.forEach((row, i) => {
        let currentX = left;
        row.forEach((val, j) => {
          cellText(
            val,
            currentX,
            ytdY + i * 20 + 4,
            ytdCols[j],
            j === 3 ? 'right' : 'left',
            j === 0 || j === 2 || j === 3
          );
          currentX += ytdCols[j];
        });
      });
      const signatureY = ytdY + 94;
      doc
        .strokeColor('#8DA4BD')
        .dash(3, { space: 3 })
        .moveTo(left, signatureY)
        .lineTo(left + 190, signatureY)
        .stroke()
        .undash();
      doc
        .strokeColor('#8DA4BD')
        .dash(3, { space: 3 })
        .moveTo(right - 190, signatureY)
        .lineTo(right, signatureY)
        .stroke()
        .undash();
      if (signatureSetting?.value) {
        try {
          doc.image(
            Buffer.from(signatureSetting.value.replace(/^data:image\/\w+;base64,/, ''), 'base64'),
            right - 130,
            signatureY - 30,
            { fit: [110, 25] }
          );
        } catch (error) {
          /* The signature is optional. */
        }
      }
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(8)
        .text('Employee Signature', left, signatureY + 6);
      doc.text('Authorized Signatory / HR Department', right - 190, signatureY + 6, {
        width: 190,
        align: 'right',
      });
      doc
        .strokeColor(BORDER)
        .moveTo(left, signatureY + 27)
        .lineTo(right, signatureY + 27)
        .stroke();
      doc
        .fillColor('#8294AB')
        .fontSize(6.8)
        .text(
          'This is a computer-generated salary document and requires no signature when electronically verified. | AA SERVICES',
          left,
          signatureY + 33,
          { width, align: 'center' }
        );
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

module.exports = { generatePayslipPDF };
