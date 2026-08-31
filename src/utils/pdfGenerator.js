const PDFDocument = require('pdfkit');
const moment = require('moment');
const SystemSettings = require('../models/SystemSettings');
const Payslip = require('../models/Payslip');
const Leave = require('../models/Leave');
const LeaveType = require('../models/LeaveType');

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

const getOrdinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const generatePayslipPDF = async (payslip, user) => {
  const startOfMonth = new Date(payslip.year, payslip.month - 1, 1);
  const endOfMonth = new Date(payslip.year, payslip.month, 0, 23, 59, 59, 999);

  const [
    signatureSetting,
    currencyNameSetting,
    currencySymbolSetting,
    leaveTypes,
    monthLeaves,
  ] = await Promise.all([
    SystemSettings.findOne({ key: 'payslip_signature' }),
    SystemSettings.findOne({ key: 'currency_name' }),
    SystemSettings.findOne({ key: 'currency_symbol' }),
    LeaveType.find({ isActive: true }).lean(),
    Leave.find({
      employeeId: user._id || payslip.employeeId,
      status: 'approved',
      $or: [
        { startDate: { $gte: startOfMonth, $lte: endOfMonth } },
        { endDate: { $gte: startOfMonth, $lte: endOfMonth } },
        { startDate: { $lte: startOfMonth }, endDate: { $gte: endOfMonth } },
      ],
    }).lean(),
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
        doc.rect(left, y, 3, 16).fill(BLUE);
        doc
          .fillColor(NAVY)
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(title, left + 9, y + 3.5);
      };
      const line = (y) =>
        doc.strokeColor(BORDER).lineWidth(0.6).moveTo(left, y).lineTo(right, y).stroke();
      const cellText = (text, x, y, w, align = 'left', bold = false) =>
        doc
          .fillColor(bold ? NAVY : '#14233A')
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8)
          .text(String(text || '-'), x + 5, y + 4.5, { width: w - 10, align, lineBreak: false });

      const logoPath = require('path').join(__dirname, '../../..', 'mve-crm-employee', 'public', 'logo.png');
      try {
        doc.image(logoPath, left - 10, 15, { fit: [110, 90] });
      } catch (e) {
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text('AA SERVICES', left, 45);
      }

      const textLeft = left + 105;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(16).text('AA SERVICES', textLeft, 24);
      
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.8);
      doc.text('Second Floor, Nasuja Building 1-89/G/36, Shilpi Valley, Plot no 36,', textLeft, 42);
      doc.text('Opposite Westin Hotel Madhapur, HITEC City, Hyderabad,', textLeft, 52);
      doc.text('Telangana, India - 500081', textLeft, 62);
      doc.text('Email: annie@myvirtualemployee.com.au', textLeft, 72);
      doc.text('Contact: +91 74166 74188', textLeft, 82);

      doc.roundedRect(right - 125, 42, 125, 24, 4).fill(NAVY);
      doc
        .fillColor('white')
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .text('SALARY PAYSLIP', right - 125, 49, { width: 125, align: 'center' });
      doc.strokeColor(NAVY).lineWidth(1.5).moveTo(left, 96).lineTo(right, 96).stroke();

      sectionTitle('1. PAY & EMPLOYEE SUMMARY', 104);
      const summaryY = 124;
      const summaryRow = 20;
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

      // Section 2: Attendance & Leave Record
      const attendanceTitleY = 232;
      sectionTitle('2. ATTENDANCE & LEAVE RECORD', attendanceTitleY);
      const summaryBarY = 251;
      const summaryBarCols = [128, 128, 128, 127];
      const summaryLabels = ['Payable Days', 'Total Cycle Days', 'LOP Days', 'Paid Leave Days'];
      const paidLeaveDays = (monthLeaves || [])
        .filter((l) => {
          const lt = (leaveTypes || []).find(
            (t) => (t.name || '').toLowerCase() === (l.leaveType || '').toLowerCase()
          );
          return lt ? lt.isPaid !== false : !l.leaveType?.toLowerCase().includes('unpaid');
        })
        .reduce((sum, l) => sum + (l.numberOfDays || 0), 0);
      const summaryVals = [
        String(payslip.daysWorked ?? 0),
        String(payslip.totalDays ?? 0),
        String(payslip.lopDays ?? 0),
        String(paidLeaveDays ?? 0),
      ];

      doc.strokeColor(BORDER).rect(left, summaryBarY, width, 18).stroke();
      let sx = left;
      summaryLabels.forEach((label, i) => {
        doc
          .fillColor('#64748B')
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .text(`${label}: `, sx + 5, summaryBarY + 5, { lineBreak: false });
        doc
          .fillColor(i === 2 ? '#E11D48' : i === 3 ? '#059669' : NAVY)
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .text(summaryVals[i], sx + summaryBarCols[i] - 28, summaryBarY + 5, {
            width: 24,
            align: 'right',
            lineBreak: false,
          });
        if (i) doc.moveTo(sx, summaryBarY).lineTo(sx, summaryBarY + 18).stroke();
        sx += summaryBarCols[i];
      });

      const attTableY = summaryBarY + 22;
      const attRowHeight = 15;
      doc.rect(left, attTableY, width, attRowHeight).fill(NAVY);
      const attHeaders = [
        'Leave Type',
        'Date',
        'No of days',
        'Hours Taken',
        'Leave Category',
        'Unit',
        'Available Balance',
      ];
      const attCols = [85, 120, 42, 50, 65, 38, 111];
      let ax = left;
      attHeaders.forEach((h, i) => {
        doc
          .fillColor('white')
          .font('Helvetica-Bold')
          .fontSize(7.2)
          .text(h, ax + 2, attTableY + 4, {
            width: attCols[i] - 4,
            align: i === 0 ? 'left' : i === 6 ? 'right' : 'center',
            lineBreak: false,
          });
        ax += attCols[i];
      });

      let leaveRows = [];
      if (monthLeaves && monthLeaves.length > 0) {
        const groups = new Map();
        monthLeaves.forEach((l) => {
          const key = (l.leaveType || 'Leave').trim();
          const existing = groups.get(key) || [];
          existing.push(l);
          groups.set(key, existing);
        });

        leaveRows = Array.from(groups.entries()).map(([typeName, reqs]) => {
          const lt = (leaveTypes || []).find(
            (t) => (t.name || '').toLowerCase() === typeName.toLowerCase()
          );
          const hrsRate = lt?.workingHoursPerDay || 8;
          const isPaid = lt ? lt.isPaid !== false : !typeName.toLowerCase().includes('unpaid');

          const totalDays = reqs.reduce((sum, r) => sum + (r.numberOfDays || 1), 0);
          const totalHours = Number((totalDays * hrsRate).toFixed(2));

          const sortedReqs = [...reqs].sort(
            (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
          );

          const dateTokens = [];
          sortedReqs.forEach((r) => {
            const sDate = new Date(r.startDate);
            const eDate = new Date(r.endDate);
            const startDay = sDate.getDate();
            const endDay = eDate.getDate();

            if (
              !r.endDate ||
              r.startDate === r.endDate ||
              sDate.toDateString() === eDate.toDateString() ||
              startDay === endDay
            ) {
              dateTokens.push(getOrdinal(startDay));
            } else {
              dateTokens.push(`${getOrdinal(startDay)} - ${getOrdinal(endDay)}`);
            }
          });

          const dateStr = dateTokens.length > 0 ? dateTokens.join(', ') : '-';
          const currBal = user.leaveBalance?.[typeName] ?? 0;

          return [
            typeName,
            dateStr,
            String(totalDays),
            String(totalHours),
            isPaid ? 'Paid Leave' : 'Unpaid / LOP',
            'Days',
            `${Number(Number(currBal).toFixed(2))} Days (${Number((currBal * hrsRate).toFixed(2))}h)`,
          ];
        });
      } else if (leaveTypes && leaveTypes.length > 0) {
        leaveRows = leaveTypes
          .filter((t) => t.isPaid !== false)
          .slice(0, 2)
          .map((t) => {
            const hrsRate = t.workingHoursPerDay || 8;
            const currBal = user.leaveBalance?.[t.name] ?? 0;
            return [
              t.name,
              '-',
              '0',
              '0',
              t.isPaid !== false ? 'Paid Leave' : 'Unpaid / LOP',
              'Days',
              `${Number(Number(currBal).toFixed(2))} Days (${Number((currBal * hrsRate).toFixed(2))}h)`,
            ];
          });
      } else {
        leaveRows = [
          [
            payslip.lopDays > 0 ? 'Loss of Pay (LOP)' : 'Annual Leave',
            '-',
            String(payslip.lopDays > 0 ? payslip.lopDays : 0),
            String(payslip.lopDays > 0 ? payslip.lopDays * 8 : 0),
            payslip.lopDays > 0 ? 'Unpaid / LOP' : 'Paid Leave',
            'Days',
            '0 Days (0h)',
          ],
        ];
      }

      const attDataY = attTableY + attRowHeight;
      const attRowCount = leaveRows.length;
      doc.strokeColor(BORDER).rect(left, attDataY, width, attRowHeight * attRowCount).stroke();

      ax = left;
      attCols.slice(0, -1).forEach((col) => {
        ax += col;
        doc.moveTo(ax, attTableY).lineTo(ax, attDataY + attRowHeight * attRowCount).stroke();
      });

      leaveRows.forEach((row, rIdx) => {
        let rx = left;
        row.forEach((val, cIdx) => {
          doc
            .fillColor(NAVY)
            .font(cIdx === 0 || cIdx === 6 ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(7.2)
            .text(val, rx + 2, attDataY + rIdx * attRowHeight + 4, {
              width: attCols[cIdx] - 4,
              align: cIdx === 0 ? 'left' : cIdx === 6 ? 'right' : 'center',
              lineBreak: false,
            });
          rx += attCols[cIdx];
        });
        line(attDataY + (rIdx + 1) * attRowHeight);
      });

      // Section 3: Salary Breakdown
      const breakdownTitleY = attDataY + attRowHeight * attRowCount + 9;
      sectionTitle(
        '3. MONTHLY SALARY BREAKDOWN & FINANCIAL YEAR YTD (01 APR - 31 MAR)',
        breakdownTitleY
      );
      const tableY = breakdownTitleY + 20;
      const tableCols = [111, 72, 72, 111, 72, 73];
      const earnings = (payslip.items || []).filter((item) => item.type === 'ALLOWANCE');
      const deductions = (payslip.items || []).filter((item) => item.type === 'DEDUCTION');
      const rows = Math.max(5, earnings.length, deductions.length);
      const rowHeight = 15;
      doc.rect(left, tableY, width, rowHeight).fill(NAVY);
      const headers = [
        'Earnings',
        `Current (${currencySymbol})`,
        `YTD (${currencySymbol})`,
        'Deductions',
        `Current (${currencySymbol})`,
        `YTD (${currencySymbol})`,
      ];
      let x = left;
      headers.forEach((header, i) => {
        doc
          .fillColor('white')
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .text(header, x + 6, tableY + 4, {
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

      const netY = totalY + rowHeight + 8;
      doc.roundedRect(left, netY, width, 44, 4).fill(NAVY);
      doc
        .fillColor('white')
        .font('Helvetica-Bold')
        .fontSize(11)
        .text('NET SALARY PAYABLE (A - B)', left + 12, netY + 11);
      doc
        .font('Helvetica')
        .fontSize(8)
        .text(
          `Amount in Words: ${currencyName} ${numberToWords(payslip.netPay)} Only`,
          left + 12,
          netY + 28
        );
      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .text(money(payslip.netPay, currencySymbol), right - 150, netY + 13, {
          width: 136,
          align: 'right',
        });

      const ytdTitleY = netY + 52;
      sectionTitle('4. YEAR TO DATE (YTD) SUMMARY - FINANCIAL YEAR (01 APR - 31 MAR)', ytdTitleY);
      const ytdY = ytdTitleY + 20;
      doc.roundedRect(left, ytdY, width, 60, 4).strokeColor('#AFC4DD').lineWidth(0.8).stroke();
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
            ytdY + i * 18 + 2,
            ytdCols[j],
            j === 3 ? 'right' : 'left',
            j === 0 || j === 2 || j === 3
          );
          currentX += ytdCols[j];
        });
      });
      const signatureY = ytdY + 80;
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
            signatureY - 26,
            { fit: [110, 22] }
          );
        } catch (error) {
          /* The signature is optional. */
        }
      }
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(7.8)
        .text('Employee Signature', left, signatureY + 5);
      doc.text('Authorized Signatory / HR Department', right - 190, signatureY + 5, {
        width: 190,
        align: 'right',
      });
      doc
        .strokeColor(BORDER)
        .moveTo(left, signatureY + 23)
        .lineTo(right, signatureY + 23)
        .stroke();
      doc
        .fillColor('#8294AB')
        .fontSize(6.5)
        .text(
          'This is a computer-generated salary document and requires no signature when electronically verified. | AA SERVICES',
          left,
          signatureY + 28,
          { width, align: 'center' }
        );
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
};

module.exports = { generatePayslipPDF };
