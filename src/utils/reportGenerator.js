import ExcelJS from 'exceljs';
import { getDBCollections } from '../config/db.js';

export async function generateExcelReport(sessionId, startDateString, endDateString) {
    const { logsCollection } = getDBCollections();
    if (!logsCollection) {
        throw new Error('Database is not connected. Reports are only available when using MongoDB.');
    }

    let query = {};

    // Filter by sessionId if explicitly specified and not 'all'
    if (sessionId && sessionId !== 'all') {
        const cleanSess = sessionId.replace(/\D/g, '');
        if (cleanSess) {
            query.$or = [
                { sessionId: sessionId },
                { sessionId: cleanSess },
                { number: { $regex: cleanSess, $options: 'i' } }
            ];
        } else {
            query.sessionId = sessionId;
        }
    }

    if (startDateString && endDateString) {
        query.dateString = {
            $gte: startDateString,
            $lte: endDateString
        };
    } else if (startDateString && startDateString !== 'all') {
        query.dateString = startDateString;
    } else if (!startDateString) {
        const today = new Date().toISOString().split('T')[0];
        query.dateString = today;
        startDateString = today;
    }
    // If startDateString === 'all', no dateString query filter is added.

    let records = await logsCollection.find(query).toArray();

    // Fallback: if session-specific query returns 0 records, try querying across all sessions for the date range
    if (records.length === 0 && sessionId && sessionId !== 'all') {
        const fallbackQuery = { ...query };
        delete fallbackQuery.$or;
        delete fallbackQuery.sessionId;
        records = await logsCollection.find(fallbackQuery).toArray();
    }

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
        const dateFormatted = record.timestamp ? new Date(record.timestamp).toLocaleString() : 'N/A';
        worksheet.addRow({
            sessionId: record.sessionId || sessionId || 'default',
            timestamp: dateFormatted,
            number: plainNumber,
            societyName: record.societyName || 'N/A',
            selectedOptions: record.selectedOptions || 'None'
        });
    });

    return { buffer: await workbook.xlsx.writeBuffer(), count: records.length };
}
