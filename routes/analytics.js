const router=require('express').Router(); const c=require('../controllers/analyticsController'); router.get('/',c.index); module.exports=router;
