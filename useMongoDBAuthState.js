import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

export default async function useMongoDBAuthState(collection, sessionId) {
    const prefix = sessionId ? `${sessionId}-` : '';

    const writeData = async (data, id) => {
        try {
            const dataStr = JSON.stringify(data, BufferJSON.replacer);
            await collection.updateOne(
                { _id: prefix + id },
                { $set: { data: dataStr } },
                { upsert: true }
            );
        } catch (error) {
            console.error('Error writing auth state to MongoDB:', error);
        }
    };

    const readData = async (id) => {
        try {
            const result = await collection.findOne({ _id: prefix + id });
            if (result && result.data) {
                return JSON.parse(result.data, BufferJSON.reviver);
            }
        } catch (error) {
            console.error('Error reading auth state from MongoDB:', error);
        }
        return null;
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: prefix + id });
        } catch (error) {
            console.error('Error removing auth state from MongoDB:', error);
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
}
