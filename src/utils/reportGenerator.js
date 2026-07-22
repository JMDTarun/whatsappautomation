import ExcelJS from 'exceljs';
import { getDBCollections } from '../config/db.js';

export async function generateExcelReport(sessionId, startDateString, endDateString) {
    const { logsCollection } = getDBCollections();
    if (!logsCollection) {
        throw new Error('Database is not connected. Reports are only available when using MongoDB.');
    }

    let query = {};

    // Filter by sessionId if provided
    if (sessionId) {
        query.sessionId = sessionId;
    }

    if (startDateString && endDateString) {
        query.dateString = {
            $gte: startDateString,
            $lte: endDateString
        };
    } else if (startDateString) {
        query.dateString = startDateString;
    } else {
        const today = new Date().toISOString().split('T')[0];
        query.dateString = today;
        startDateString = today;
    }

    const records = await logsCollection.find(query).toArray();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Keyword Matches');

    worksheet.columns = [
        { header: 'Source Number', key: 'sessionId', width: 20 },
        { header: 'Date & Time', key: 'timestamp', width: 25 },
        { header: 'Phone Number', key: 'number', width: 20 },
        { header: 'Society', key: 'societyName', width: 30 },
        { header: 'Selected Options', key: 'selectedOptions', width: 50 },
    ];

    records.forEach(record => {
        const plainNumber = record.number ? record.number.split('@')[0] : '';
        worksheet.addRow({
            sessionId: record.sessionId || 'default',
            timestamp: new Date(record.timestamp).toLocaleString(),
            number: plainNumber,
            societyName: record.societyName || 'N/A',
            selectedOptions: record.selectedOptions || 'None'
        });
    });

    return { buffer: await workbook.xlsx.writeBuffer(), count: records.length };
}
